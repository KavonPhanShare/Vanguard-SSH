const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

let mainWindow;
let conn = new Client();
let sftpSession = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false, // Required for our direct IPC/FS usage
    }
  });

  mainWindow.loadFile('index.html');
}

// --- APP DATA PATH LISTENER ---
// Essential for production so Saved Hosts go to AppData instead of the install folder
ipcMain.on('get-user-data-path', (event) => {
  event.returnValue = app.getPath('userData');
});

// --- SSH & SFTP CORE LOGIC ---
ipcMain.on('ssh-connect', (event, { host, username, password }) => {
  // Clear any existing connection attempt
  conn = new Client();

  conn.on('ready', () => {
    // 1. Setup Interactive Shell (Terminal)
    conn.shell((err, stream) => {
      if (err) return event.reply('ssh-error', err.message);
      
      event.reply('ssh-status', 'Connected');

      // Forward data from Server to Frontend
      stream.on('data', (data) => {
        event.reply('ssh-data', data.toString());
      });

      // Forward input from Frontend to Server
      ipcMain.on('ssh-input', (e, input) => {
        stream.write(input);
      });

      stream.on('close', () => {
        event.reply('ssh-error', 'Stream Closed');
        conn.end();
      });
    });

    // 2. Setup SFTP Subsystem (File Explorer)
    conn.sftp((err, sftp) => {
      if (err) return console.error("SFTP Error:", err);
      sftpSession = sftp;
      
      // Default to listing the home directory (.)
      listRemoteDir(event, '.');
    });

  }).on('error', (err) => {
    event.reply('ssh-error', err.message);
  }).connect({
    host,
    port: 22,
    username,
    password,
    readyTimeout: 10000
  });
});

// Helper: List Remote Directory
function listRemoteDir(event, remotePath) {
  if (!sftpSession) return;

  sftpSession.readdir(remotePath, (err, list) => {
    if (err) return event.reply('ssh-error', `LS Failed: ${err.message}`);
    event.reply('sftp-list', { path: remotePath, files: list });
  });
}

// --- FILE EXPLORER INTERACTION ---
ipcMain.on('sftp-ls', (event, remotePath) => {
  listRemoteDir(event, remotePath);
});

// --- THE DOWNLOADER (Server -> PC) ---
ipcMain.on('sftp-download', (event, { remotePath, filename }) => {
  if (!sftpSession) return;

  dialog.showSaveDialog(mainWindow, {
    title: `Download ${filename}`,
    defaultPath: path.join(app.getPath('downloads'), filename)
  }).then(result => {
    if (!result.canceled && result.filePath) {
      const localPath = result.filePath;
      event.reply('ssh-status', `Downloading ${filename}...`);

      sftpSession.fastGet(remotePath, localPath, {}, (err) => {
        if (err) {
          event.reply('ssh-error', `Download Failed: ${err.message}`);
        } else {
          event.reply('ssh-status', `Successfully saved to ${localPath}`);
        }
      });
    }
  }).catch(err => console.error("Dialog Error:", err));
});

// --- THE UPLOADER (PC -> Server) ---
ipcMain.on('sftp-upload', (event, { remoteDir }) => {
  if (!sftpSession) return;

  dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select File to Upload'
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      const localPath = result.filePaths[0];
      const filename = path.basename(localPath);
      const remotePath = `${remoteDir}/${filename}`;

      event.reply('ssh-status', `Uploading ${filename}...`);

      sftpSession.fastPut(localPath, remotePath, {}, (err) => {
        if (err) {
          event.reply('ssh-error', `Upload Failed: ${err.message}`);
        } else {
          event.reply('ssh-status', `Uploaded ${filename} successfully!`);
          listRemoteDir(event, remoteDir); // Refresh list
        }
      });
    }
  }).catch(err => console.error("Upload Dialog Error:", err));
});

// App Lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});