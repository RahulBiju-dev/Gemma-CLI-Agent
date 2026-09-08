const { app, BrowserWindow, dialog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBackendEnvironmentFile } = require('./backend_environment');

const BACKEND_START_TIMEOUT_MS = 15 * 60 * 1000;
const BACKEND_READY_TIMEOUT_MS = 30000;
const BACKEND_STOP_GRACE_MS = 8000;
const MAX_DIAGNOSTIC_CHARS = 16000;

// Hybrid-GPU Wayland systems can leave stale rectangular compositor tiles
// over animated canvas and rounded UI surfaces. Selene's interface is light
// enough to render smoothly in software; hardware acceleration remains an
// explicit opt-in for users who need it.
const hardwareAccelerationEnabled = /^(1|true|yes)$/i.test(
  String(process.env.SELENE_HARDWARE_ACCELERATION || '').trim(),
);
if (!hardwareAccelerationEnabled) app.disableHardwareAcceleration();

let mainWindow = null;
let backendProcess = null;
let backendPort = null;
let backendOwnerToken = null;
let backendStartPromise = null;
let shutdownPromise = null;
let shutdownComplete = false;
let shutdownRequested = false;

function executableOnPath(name) {
  if (!name || name.includes('\0')) return null;
  if (path.isAbsolute(name)) {
    try {
      fs.accessSync(name, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return name;
    } catch (_) {
      return null;
    }
  }
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === 'win32' && !path.extname(name) ? `${name}${extension}` : name);
      try {
        fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch (_) {
        // Continue through the bounded PATH list.
      }
    }
  }
  return null;
}

function resolveBackendCommand() {
  const sourceBackend = path.resolve(__dirname, '..', 'main.py');
  if (app.isPackaged) {
    const executableName = process.platform === 'win32' ? 'selene-backend.exe' : 'selene-backend';
    const candidates = [
      path.join(process.resourcesPath, executableName),
      path.join(process.resourcesPath, 'resources', executableName),
    ];
    const executable = candidates.map(candidate => executableOnPath(candidate)).find(Boolean);
    if (!executable) {
      throw new Error(`Packaged Selene backend is missing (${candidates.join(', ')}).`);
    }
    return { executable, args: ['--no-browser'], cwd: app.getPath('userData'), label: executable };
  }

  const explicitPython = (process.env.SELENE_PYTHON || '').trim();
  const preferences = explicitPython
    ? [explicitPython]
    : (process.platform === 'win32' ? ['python.exe', 'py.exe', 'python'] : ['python3', 'python']);
  let python = null;
  for (const candidate of preferences) {
    python = executableOnPath(candidate);
    if (python) break;
  }
  if (!python) {
    throw new Error('No native Python interpreter was found. Set SELENE_PYTHON to an installed Python executable.');
  }
  const usePythonLauncher = process.platform === 'win32' && path.basename(python).toLowerCase() === 'py.exe';
  return {
    executable: python,
    args: [...(usePythonLauncher ? ['-3'] : []), sourceBackend, '--no-browser'],
    cwd: path.dirname(sourceBackend),
    label: sourceBackend,
  };
}

function resolveAppIcon() {
  const candidates = [
    '/home/rahulb/Documents/Applications/Selene/icon.png',
    path.join(__dirname, '../build/icon.png'),
    path.join(__dirname, '../agent/static/favicon.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function createWindow(port) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // The UI's narrowest supported layout. Without a floor the window can be
    // dragged smaller than the compact breakpoint handles, and body overflow is
    // hidden, so whatever gets clipped is unreachable.
    minWidth: 380,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    icon: resolveAppIcon(),
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (!shutdownComplete) {
      console.error(`Selene UI failed to load (${code}): ${description}`);
    }
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function waitForBackendPort(child) {
  return new Promise((resolve, reject) => {
    let outputBuffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Timed out waiting for Selene backend port announcement.')), BACKEND_START_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    function finish(error, port) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(port);
    }
    function onData(chunk) {
      const output = chunk.toString();
      outputBuffer = (outputBuffer + output).slice(-MAX_DIAGNOSTIC_CHARS);
      const match = outputBuffer.match(/(?:^|\r?\n)ELECTRON_PORT:(\d{1,5})(?:\r?\n|$)/);
      if (!match) return;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        finish(new Error(`Backend announced an invalid port: ${match[1]}`));
        return;
      }
      finish(null, port);
    }
    function onError(error) {
      finish(new Error(`Could not start Selene backend: ${error.message}`));
    }
    function onExit(code, signal) {
      finish(new Error(`Selene backend exited before readiness (code=${code}, signal=${signal || 'none'}).`));
    }

    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function probeBackend(port) {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 1000 }, response => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitForBackendReady(port, child) {
  const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Selene backend exited during readiness checks.');
    }
    if (await probeBackend(port)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Selene backend did not become ready on port ${port}.`);
}

function backendEnvironment(ownerToken) {
  const environment = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    SELENE_ELECTRON: '1',
    SELENE_BACKEND_OWNER: ownerToken,
  };
  const envFile = resolveBackendEnvironmentFile({
    env: environment,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    executablePath: process.execPath,
    appImagePath: process.env.APPIMAGE,
  });
  if (envFile && !environment.SELENE_ENV_FILE) {
    environment.SELENE_ENV_FILE = envFile;
  }
  return environment;
}

async function startBackend() {
  if (backendStartPromise) return backendStartPromise;
  backendStartPromise = (async () => {
    const command = resolveBackendCommand();
    const ownerToken = `${process.pid}:${crypto.randomUUID()}`;
    fs.mkdirSync(command.cwd, { recursive: true });
    console.log(`Starting Selene backend from ${command.label}...`);
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: backendEnvironment(ownerToken),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // A separate POSIX process group lets Selene terminate only the tree it
      // owns. Windows uses taskkill /T against this exact child PID.
      detached: process.platform !== 'win32',
    });
    backendProcess = child;
    backendOwnerToken = ownerToken;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    // Keep both pipes drained for the lifetime of the backend. Removing the
    // temporary port parser after readiness must never let a chatty backend
    // fill the OS pipe buffer and deadlock.
    child.stdout.on('data', data => {
      const output = data.toString();
      stdoutBuffer = (stdoutBuffer + output).slice(-MAX_DIAGNOSTIC_CHARS);
      console.log(`[Backend stdout] ${output.trimEnd()}`);
    });
    child.stderr.on('data', data => {
      const output = data.toString();
      stderrBuffer = (stderrBuffer + output).slice(-MAX_DIAGNOSTIC_CHARS);
      console.error(`[Backend stderr] ${output.trimEnd()}`);
    });
    child.on('exit', (code, signal) => {
      const wasCurrent = backendProcess === child;
      if (wasCurrent) {
        backendProcess = null;
        backendPort = null;
        backendOwnerToken = null;
      }
      console.log(`Backend process exited (code=${code}, signal=${signal || 'none'}).`);
      if (wasCurrent && !shutdownRequested && !shutdownComplete && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox('Selene backend stopped', 'The Selene-owned backend process exited. Ollama and user data were not stopped or removed.');
        app.quit();
      }
    });

    try {
      const port = await waitForBackendPort(child);
      await waitForBackendReady(port, child);
      if (backendProcess !== child) throw new Error('Selene backend ownership changed during startup.');
      backendPort = port;
      createWindow(port);
      return port;
    } catch (error) {
      error.backendDiagnostics = [stdoutBuffer, stderrBuffer].filter(Boolean).join('\n').slice(-MAX_DIAGNOSTIC_CHARS);
      throw error;
    }
  })();
  return backendStartPromise;
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

function taskkillTree(pid, force) {
  return new Promise(resolve => {
    const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
    const killer = spawn('taskkill.exe', args, {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    killer.once('error', () => resolve(false));
    killer.once('exit', code => resolve(code === 0));
  });
}

function requestBackendShutdown(port, ownerToken) {
  if (!port || !ownerToken) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/shutdown',
      method: 'POST',
      timeout: 1500,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '2',
        'X-Selene-Backend-Owner': ownerToken,
      },
    }, response => {
      response.resume();
      resolve(response.statusCode === 202);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end('{}');
  });
}

async function stopBackend() {
  if (shutdownPromise) return shutdownPromise;
  const child = backendProcess;
  if (!child) return;
  shutdownRequested = true;
  shutdownPromise = (async () => {
    // ``child`` is the exact process spawned above. Selene never enumerates or
    // stops Ollama, another Selene backend, or an unrelated process by name.
    await requestBackendShutdown(backendPort, backendOwnerToken);
    if (await waitForExit(child, BACKEND_STOP_GRACE_MS)) return;
    if (process.platform === 'win32') {
      await taskkillTree(child.pid, false);
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_) {
        try { child.kill('SIGTERM'); } catch (_) { /* already exited */ }
      }
    }
    if (await waitForExit(child, 2000)) return;
    if (process.platform === 'win32') {
      await taskkillTree(child.pid, true);
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_) {
        try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
      }
    }
    await waitForExit(child, 1000);
  })();
  return shutdownPromise;
}

const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => startBackend()).catch(async error => {
    const diagnostics = String(error.backendDiagnostics || '').trim();
    const detail = diagnostics ? `\n\nBackend output:\n${diagnostics}` : '';
    dialog.showErrorBox('Selene could not start', `${error.message}${detail}`.slice(0, MAX_DIAGNOSTIC_CHARS));
    await stopBackend();
    shutdownComplete = true;
    app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow && backendPort) createWindow(backendPort);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', event => {
    if (shutdownComplete || !backendProcess) return;
    event.preventDefault();
    stopBackend().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
}

module.exports = {
  executableOnPath,
  resolveBackendCommand,
  waitForBackendPort,
  probeBackend,
};
