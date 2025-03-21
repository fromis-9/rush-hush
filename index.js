const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
} = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

// Enable debugging
const DEBUG = true;
function debugLog(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

debugLog("Starting app...");

// Keep a global reference of the window object and active process
let mainWindow;
global.activePythonProcess = null;

function createWindow() {
  debugLog("Creating main window...");

  // Create the browser window with your specified dimensions
  mainWindow = new BrowserWindow({
    width: 500,
    height: 400,
    minWidth: 500,
    minHeight: 400,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isMac = process.platform === "darwin";

  const template = [
    // App menu (only for macOS)
    ...(isMac
      ? [
          {
            label: "video.fm",
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []), // If not macOS, don't include this menu

    {
      label: "File",
      submenu: [
        { role: "close" },
        ...(isMac ? [] : [{ label: "Exit", role: "quit" }]), // Add Exit on Windows/Linux
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggledevtools" }],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Learn More",
          click: async () => {
            const { shell } = require("electron");
            await shell.openExternal(
              "https://github.com/fromis-9/videofm-beta"
            );
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Load the index.html file from the renderer folder
  const rendererPath = path.join(__dirname, "renderer", "index.html");
  debugLog("Loading renderer from:", rendererPath);
  mainWindow.loadFile(rendererPath);

  // Open DevTools during development for debugging
  /*if (DEBUG) {
    mainWindow.webContents.openDevTools();
  }*/

  // Log when window is ready
  mainWindow.webContents.on("did-finish-load", () => {
    debugLog("Main window loaded successfully");
  });
}

function getVideosPath() {
  const userDataPath = app.getPath("userData");
  const videosPath = path.join(userDataPath, "Videos");

  // Create the videos directory if it doesn't exist
  if (!fs.existsSync(videosPath)) {
    fs.mkdirSync(videosPath, { recursive: true });
  }

  return videosPath;
}

// Function to extract the generated filename from Python output
function findGeneratedFilename(output) {
  // Look for the final video filename in the output
  const match =
    output.match(/Final video saved as: ([a-zA-Z0-9_.-]+\.mp4)/i) ||
    output.match(
      /Video compilation complete! Saved as: ([a-zA-Z0-9_.-]+\.mp4)/i
    ) ||
    output.match(
      /Copied final video to current directory: ([a-zA-Z0-9_.-]+\.mp4)/i
    );
  return match ? match[1] : null;
}

function cleanupOnExit() {
  try {
    const fs = require("fs");
    const path = require("path");
    const appDir = __dirname;

    // Delete clips folder if it exists
    const clipsDir = path.join(appDir, "clips");
    if (fs.existsSync(clipsDir)) {
      console.log("Cleaning up clips folder...");
      deleteFolderRecursive(clipsDir);
    }

    // Delete progress.json if it exists
    const cacheDir = path.join(appDir, "cache");
    if (fs.existsSync(cacheDir)) {
      const progressFile = path.join(cacheDir, "progress.json");
      if (fs.existsSync(progressFile)) {
        console.log("Cleaning up progress.json file...");
        fs.unlinkSync(progressFile);
      }
    }

    console.log("Cleanup completed successfully");
  } catch (error) {
    console.error("Error during cleanup:", error);
  }
}

// Helper function to recursively delete folders
function deleteFolderRecursive(folderPath) {
  const fs = require("fs");

  if (fs.existsSync(folderPath)) {
    fs.readdirSync(folderPath).forEach((file) => {
      const curPath = path.join(folderPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        // Recursive call for directories
        deleteFolderRecursive(curPath);
      } else {
        // Delete file
        fs.unlinkSync(curPath);
      }
    });

    // Delete the now-empty directory
    fs.rmdirSync(folderPath);
  }
}

// Register all IPC handlers
function registerIpcHandlers() {
  debugLog("Registering IPC handlers...");

  // Handler for running the Python script
  ipcMain.handle("run-videofm", async (event, config) => {
    debugLog(
      "Received run-videofm request with config:",
      config.username,
      config.year,
      config.month
    );
    try {
      // Get the videos path
      const videosPath = getVideosPath();
      debugLog("Videos path:", videosPath);

      // Create temporary file with API keys in user data directory
      const userDataPath = app.getPath("userData");
      debugLog("User data path:", userDataPath);

      // Define envContent here
      const envContent = `LASTFM_API_KEY=${config.lastfmApiKey}\nYOUTUBE_API_KEY=${config.youtubeApiKey}`;

      const envPath = path.join(userDataPath, ".env");
      debugLog("Env file path:", envPath);

      // Make sure directory exists
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.writeFileSync(envPath, envContent);
      debugLog(".env file created at:", envPath);

      let exePath;
      if (app.isPackaged) {
        // For packaged app on macOS
        const possiblePaths = [
          path.join(process.resourcesPath, "videofm"),
          path.join(process.resourcesPath, "dist", "videofm", "videofm"),
          path.join(process.resourcesPath, "app", "dist", "videofm", "videofm"),
          path.join(
            process.resourcesPath,
            "app.asar.unpacked",
            "dist",
            "videofm",
            "videofm"
          ),
          path.join(process.resourcesPath, "..", "videofm"),
          path.join(app.getPath("userData"), "videofm"),
        ];

        // Log all paths we're checking
        debugLog("App is packaged, checking possible executable paths:");
        for (const possiblePath of possiblePaths) {
          const exists = fs.existsSync(possiblePath);
          debugLog(`- ${possiblePath}: ${exists ? "EXISTS" : "NOT FOUND"}`);
          if (exists) {
            exePath = possiblePath;
            break;
          }
        }

        if (!exePath) {
          // If we still don't have a path, look for any file containing "videofm" in resources
          debugLog("Searching for videofm executable in resources directory");
          try {
            const resourcesFiles = fs.readdirSync(process.resourcesPath);
            debugLog("Files in resources directory:", resourcesFiles);
          } catch (err) {
            debugLog("Error reading resources directory:", err);
          }
        }
      } else {
        // For development
        exePath = path.join(__dirname, "dist", "videofm", "videofm");
        debugLog("Dev mode executable path:", exePath);
      }

      // Declare pythonProcess variable
      let pythonProcess;

      // Check if we found the executable in packaged mode
      if (app.isPackaged && exePath) {
        // Use the executable we found
        debugLog("Using found executable:", exePath);
        pythonProcess = spawn(
          exePath,
          [
            "--env-path",
            envPath,
            "--output-dir",
            videosPath,
            "--codec",
            config.codec || "libx264",
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
      } else {
        // Fall back to Python script
        debugLog("Using Python directly with script");
        pythonProcess = spawn(
          "python",
          [
            "videofm.py",
            "--env-path",
            envPath,
            "--output-dir",
            videosPath,
            "--codec",
            config.codec || "libx264",
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
      }

      // Storing the process globally so it can terminate it if needed
      global.activePythonProcess = pythonProcess;
      debugLog("Python process started");

      // Add these event listeners to your pythonProcess
      pythonProcess.stderr.on("data", (data) => {
        const errorOutput = data.toString();
        debugLog("Python error (stderr):", errorOutput);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("python-error", errorOutput);
        }
      });

      pythonProcess.on("error", (error) => {
        debugLog("Python process error event:", error.message);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            "python-error",
            "Process error: " + error.message
          );
        }
      });

      pythonProcess.on("exit", (code, signal) => {
        debugLog(
          `Python process exited with code ${code} and signal ${signal}`
        );
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            "python-output",
            `Process exited with code ${code} and signal ${signal}`
          );
        }
      });

      // Send user inputs when prompted
      pythonProcess.stdout.on("data", (data) => {
        const output = data.toString();
        debugLog(
          "Python output:",
          output.substring(0, 100) + (output.length > 100 ? "..." : "")
        );

        // Send output to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("python-output", output);
        }

        // Handle Python script input prompts
        if (output.includes("Enter your Last.fm username:")) {
          debugLog("Sending username:", config.username);
          pythonProcess.stdin.write(config.username + "\n");
        } else if (output.includes("Enter the target year")) {
          debugLog("Sending year:", config.year);
          pythonProcess.stdin.write(config.year + "\n");
        } else if (output.includes("Enter the target month")) {
          debugLog("Sending month:", config.month);
          pythonProcess.stdin.write(config.month + "\n");
        } else if (output.includes("Enter the number of top songs")) {
          debugLog("Sending number of songs:", config.numSongs);
          pythonProcess.stdin.write(config.numSongs + "\n");
        } else if (
          output.includes("Do you want to manually input YouTube URLs")
        ) {
          debugLog(
            "Sending manual YouTube preference:",
            config.allowManualYoutube
          );
          pythonProcess.stdin.write(
            config.allowManualYoutube ? "yes\n" : "no\n"
          );
        } else if (output.includes("Enter a manual YouTube URL")) {
          debugLog("Requesting YouTube URL from user");
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("request-youtube-url", output);
          }
        } else if (output.includes("Do you need to replace any videos?")) {
          debugLog("Asking if user wants to replace videos");
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("ask-replace-videos", output);
          }
        }
      });

      // Handle errors
      pythonProcess.stderr.on("data", (data) => {
        const errorOutput = data.toString();
        debugLog("Python error:", errorOutput);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("python-error", errorOutput);
        }
      });

      // Handle process completion
      return new Promise((resolve, reject) => {
        let output = "";

        pythonProcess.stdout.on("data", (data) => {
          output += data.toString();
        });

        pythonProcess.on("close", (code) => {
          debugLog("Python process closed with code:", code);
          global.activePythonProcess = null;

          if (code === 0) {
            // Find the generated file name
            const filename = findGeneratedFilename(output);
            debugLog("Generated filename:", filename);

            if (filename) {
              const filePath = path.join(__dirname, filename);
              resolve({
                success: true,
                message: "Video created successfully!",
                filePath,
              });
            } else {
              resolve({
                success: true,
                message: "Video created successfully!",
              });
            }
          } else {
            reject(new Error(`Process exited with code ${code}`));
          }
        });
      });
    } catch (error) {
      debugLog("Error running Python script:", error.message);
      return { success: false, error: error.message };
    }
  });

  // Handler to open the video file in the system explorer
  ipcMain.handle("show-in-folder", (event, filePath) => {
    debugLog("Received show-in-folder request for:", filePath);
    if (fs.existsSync(filePath)) {
      debugLog("Opening file in explorer");
      shell.showItemInFolder(filePath);
      return { success: true };
    }
    debugLog("File not found");
    return { success: false, error: "File not found" };
  });

  // Handler to open the app folder
  ipcMain.handle("open-app-folder", () => {
    debugLog("Received open-app-folder request");
    try {
      const videosPath = getVideosPath();
      debugLog("Opening videos folder:", videosPath);

      shell.openPath(videosPath);
      return { success: true };
    } catch (error) {
      debugLog("Error opening videos folder:", error);
      return { success: false, error: error.message };
    }
  });

  // Handler to stop the running process
  ipcMain.handle("stop-process", async () => {
    debugLog("Received stop-process request");
    try {
      if (global.activePythonProcess) {
        // Try SIGTERM first
        debugLog("Sending SIGTERM to Python process");
        const killed = global.activePythonProcess.kill("SIGTERM");

        // If SIGTERM didn't work, try force kill after a short delay
        if (!killed) {
          debugLog("SIGTERM failed, trying force kill");
          setTimeout(() => {
            try {
              global.activePythonProcess.kill("SIGKILL");
            } catch (e) {
              debugLog("Error in force kill:", e);
            }
          }, 500);
        }

        // Clean up the clips folder if it exists
        const clipsDir = path.join(__dirname, "clips");
        if (fs.existsSync(clipsDir)) {
          try {
            debugLog("Removing clips directory");
            fs.rmdirSync(clipsDir, { recursive: true });
          } catch (err) {
            debugLog("Error removing clips directory:", err);
          }
        }

        // Clear the reference
        global.activePythonProcess = null;
        debugLog("Process stopped successfully");

        return { success: true };
      }
      debugLog("No active process to stop");
      return { success: false, error: "No active process" };
    } catch (error) {
      debugLog("Error stopping process:", error);
      return { success: false, error: error.message };
    }
  });

  // Handler to provide a new API key during execution
  ipcMain.handle("provide-api-key", (event, key) => {
    debugLog("Received provide-api-key request");
    try {
      if (global.activePythonProcess && global.activePythonProcess.stdin) {
        debugLog("Providing new API key to Python process");
        global.activePythonProcess.stdin.write(key + "\n");

        // Also update the .env file with the new key
        try {
          const envPath = path.join(__dirname, ".env");
          if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, "utf8");
            // Replace the YouTube API key
            envContent = envContent.replace(
              /YOUTUBE_API_KEY=.*/g,
              `YOUTUBE_API_KEY=${key}`
            );
            fs.writeFileSync(envPath, envContent);
            debugLog(".env file updated with new API key");
          }
        } catch (err) {
          debugLog("Error updating .env file:", err);
        }

        return { success: true };
      }
      debugLog("No active process to provide API key to");
      return { success: false, error: "No active process" };
    } catch (error) {
      debugLog("Error providing API key:", error);
      return { success: false, error: error.message };
    }
  });

  // Handler for YouTube URL input
  ipcMain.handle("provide-youtube-url", (event, url) => {
    debugLog("Received provide-youtube-url request");
    if (global.activePythonProcess && global.activePythonProcess.stdin) {
      debugLog("Providing YouTube URL to Python process");
      global.activePythonProcess.stdin.write(url + "\n");
      return { success: true };
    }
    debugLog("No active process to provide YouTube URL to");
    return { success: false, error: "No active process" };
  });

  // Handler for replace videos response
  ipcMain.handle("respond-replace-videos", (event, response) => {
    debugLog(
      "Received respond-replace-videos request with response:",
      response
    );
    if (global.activePythonProcess && global.activePythonProcess.stdin) {
      debugLog("Providing replace videos response to Python process");
      global.activePythonProcess.stdin.write(response + "\n");
      return { success: true };
    }
    debugLog("No active process to provide replace videos response to");
    return { success: false, error: "No active process" };
  });

  debugLog("All IPC handlers registered successfully");
}

// Handler to open a video file
ipcMain.handle("open-video", async (event, filePath) => {
  debugLog("Received open-video request for:", filePath);
  try {
    if (fs.existsSync(filePath)) {
      debugLog("Opening video file:", filePath);
      shell.openPath(filePath);
      return { success: true };
    }
    debugLog("Video file not found:", filePath);
    return { success: false, error: "File not found" };
  } catch (error) {
    debugLog("Error opening video:", error);
    return { success: false, error: error.message };
  }
});

// Handler to provide song number for replacement
ipcMain.handle("provide-song-number", (event, number) => {
  debugLog("Received provide-song-number request:", number);
  try {
    if (global.activePythonProcess && global.activePythonProcess.stdin) {
      debugLog("Providing song number to Python process");
      global.activePythonProcess.stdin.write(number + "\n");
      return { success: true };
    }
    debugLog("No active process to provide song number to");
    return { success: false, error: "No active process" };
  } catch (error) {
    debugLog("Error providing song number:", error);
    return { success: false, error: error.message };
  }
});

// Handler to clear cache
ipcMain.handle("clear-cache", async () => {
  try {
    const userDataPath = app.getPath("userData");
    const cachePath = path.join(userDataPath, "Cache");

    if (fs.existsSync(cachePath)) {
      fs.rmdirSync(cachePath, { recursive: true });
      fs.mkdirSync(cachePath, { recursive: true });
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handler to provide replacement URL
ipcMain.handle("provide-replace-url", (event, url) => {
  debugLog("Received provide-replace-url request");
  try {
    if (global.activePythonProcess && global.activePythonProcess.stdin) {
      debugLog("Providing replacement URL to Python process");
      global.activePythonProcess.stdin.write(url + "\n");
      return { success: true };
    }
    debugLog("No active process to provide replacement URL to");
    return { success: false, error: "No active process" };
  } catch (error) {
    debugLog("Error providing replacement URL:", error);
    return { success: false, error: error.message };
  }
});

// Handler for file overwrite responses
ipcMain.handle("provide-overwrite-response", (event, response) => {
  try {
    if (global.activePythonProcess && global.activePythonProcess.stdin) {
      global.activePythonProcess.stdin.write(response + "\n");
      return { success: true };
    }
    return { success: false, error: "No active process" };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handler for opening external link
ipcMain.handle("open-external", async (event, url) => {
  debugLog("Received open-external request for:", url);
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    debugLog("Error opening external link:", error);
    return { success: false, error: error.message };
  }
});

// Create window when Electron is ready
app.whenReady().then(() => {
  debugLog("App is ready");

  // Register all IPC handlers
  registerIpcHandlers();

  // Create the main window
  createWindow();

  app.on("activate", function () {
    // Re-create window on macOS when dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS
app.on("window-all-closed", () => {
  console.log("All windows closed, performing cleanup...");

  // Terminate any running Python process
  if (global.activePythonProcess) {
    console.log("Terminating Python process...");
    global.activePythonProcess.kill();
    global.activePythonProcess = null;
  }

  cleanupOnExit();

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  console.log("App will quit, performing cleanup...");

  // Terminate any running Python process
  if (global.activePythonProcess) {
    console.log("Terminating Python process...");
    global.activePythonProcess.kill();
    global.activePythonProcess = null;
  }

  cleanupOnExit();
});

app.on("before-quit", () => {
  console.log("App before quit, performing cleanup...");

  // Terminate any running Python process
  if (global.activePythonProcess) {
    console.log("Terminating Python process...");
    global.activePythonProcess.kill();
    global.activePythonProcess = null;
  }

  cleanupOnExit();
});

// Handle any uncaught exceptions
process.on("uncaughtException", (error) => {
  debugLog("Uncaught Exception:", error);
  // Keep the app running, just log the error
});
