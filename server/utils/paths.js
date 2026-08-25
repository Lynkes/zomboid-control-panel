import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Detect if running as a pkg-compiled executable
// In pkg, process.pkg exists and __dirname points to snapshot filesystem
const isPkg = typeof process.pkg !== 'undefined';

// Get the base directory - for pkg use exe location, otherwise use project root
const baseDir = isPkg 
  ? path.dirname(process.execPath)  // Directory containing the exe
  : path.join(__dirname, '../..');   // Project root (server/utils -> project)

// Default paths (relative to base directory)
const defaultDataDir = path.join(baseDir, 'data');
const defaultLogsDir = path.join(baseDir, 'logs');

// Config file stores custom path overrides. PANEL_PATHS_CONFIG_PATH lets a
// caller point at a different config file entirely -- used by
// server/tests/vitest.globalSetup.mjs so each concurrent test run gets its
// own file instead of every process on the machine (every agent's test
// runs AND the real panel) racing on one shared path at the repo root.
// Unset (the normal case for the real panel) falls back to today's
// behaviour exactly.
const configPath = process.env.PANEL_PATHS_CONFIG_PATH
  ? path.resolve(process.env.PANEL_PATHS_CONFIG_PATH)
  : path.join(baseDir, 'paths.config.json');

// Current paths (loaded at startup)
let currentPaths = null;

/**
 * Load paths from config file or use defaults
 */
export function getDataPaths() {
  if (currentPaths) {
    return currentPaths;
  }
  
  let config = {};
  
  // Try to load custom paths from config
  if (fs.existsSync(configPath)) {
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configData);
    } catch (e) {
      console.error(`[PATHS] Failed to load paths config (${configPath}): ${e.stack || e.message}`);
    }
  }
  
  const dataDir = config.dataDir || defaultDataDir;
  const logsDir = config.logsDir || defaultLogsDir;
  
  // Ensure directories exist
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  
  currentPaths = {
    dataDir,
    logsDir,
    dbPath: path.join(dataDir, 'db.json'),
    configPath
  };
  
  return currentPaths;
}

/**
 * Copy directory recursively
 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return false;
  
  fs.mkdirSync(dest, { recursive: true });
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  
  return true;
}

/**
 * Update paths and optionally move files
 */
export async function setDataPaths(newPaths, moveFiles = true) {
  const current = getDataPaths();
  const filesMoved = { data: false, logs: false };
  
  // Validate paths — block system-critical directories
  const BLOCKED_PREFIXES = process.platform === 'win32' 
    ? [
        'c:\\windows', 'c:\\program files', 'c:\\program files (x86)',
        'c:\\programdata', 'c:\\users\\public'
      ]
    : [
        '/etc', '/usr', '/bin', '/sbin', '/var', '/boot', '/proc', '/sys', '/dev'
      ];
  
  for (const dir of [newPaths.dataDir, newPaths.logsDir]) {
    if (!dir) continue;
    if (typeof dir !== 'string' || dir.length > 500) {
      return { success: false, error: 'Invalid path format' };
    }
    const resolved = process.platform === 'win32'
      ? path.resolve(dir).toLowerCase()
      : path.resolve(dir);
    if (BLOCKED_PREFIXES.some(p => resolved.startsWith(p))) {
      return { success: false, error: 'Path targets a protected system directory' };
    }
    // Must be absolute
    if (!path.isAbsolute(resolved)) {
      return { success: false, error: 'Path must be absolute' };
    }
  }
  
  const updatedConfig = {
    dataDir: newPaths.dataDir || current.dataDir,
    logsDir: newPaths.logsDir || current.logsDir
  };
  
  // Validate paths
  try {
    // Check if paths are valid (can create directories)
    if (newPaths.dataDir) {
      const testPath = path.join(newPaths.dataDir, '.test');
      fs.mkdirSync(newPaths.dataDir, { recursive: true });
      fs.writeFileSync(testPath, 'test');
      fs.unlinkSync(testPath);
    }
    
    if (newPaths.logsDir) {
      const testPath = path.join(newPaths.logsDir, '.test');
      fs.mkdirSync(newPaths.logsDir, { recursive: true });
      fs.writeFileSync(testPath, 'test');
      fs.unlinkSync(testPath);
    }
  } catch (e) {
    return { success: false, error: `Invalid path: ${e.message}` };
  }
  
  // Move files if requested
  if (moveFiles) {
    try {
      // Move data files
      if (newPaths.dataDir && newPaths.dataDir !== current.dataDir) {
        if (fs.existsSync(current.dataDir)) {
          // Copy all files and folders from old data dir to new
          copyDirSync(current.dataDir, newPaths.dataDir);
          filesMoved.data = true;
        }
      }
      
      // Move log files
      if (newPaths.logsDir && newPaths.logsDir !== current.logsDir) {
        if (fs.existsSync(current.logsDir)) {
          // Copy all log files and folders to new location
          copyDirSync(current.logsDir, newPaths.logsDir);
          filesMoved.logs = true;
        }
      }
    } catch (e) {
      return { success: false, error: `Failed to move files: ${e.message}` };
    }
  }
  
  // Save config
  try {
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
  } catch (e) {
    return { success: false, error: `Failed to save config: ${e.message}` };
  }
  
  // Clear cached paths so they reload on next call
  currentPaths = null;
  
  return {
    success: true,
    paths: getDataPaths(),
    filesMoved
  };
}
