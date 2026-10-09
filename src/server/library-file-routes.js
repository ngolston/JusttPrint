'use strict';

/**
 * Library files for the browser (http.js registers these): /api/file/<path> streams a model for
 * viewing (previews, thumbnails), /api/download/<path> saves one, also a model inside a ZIP file
 * ("archive.zip::entry"). Only paths inside the library folders are served.
 */

const fs = require('fs');
const path = require('path');
const { parseZipPath } = require('../core/library-paths');
const { cleanupExtractTempFile } = require('../core/extract-temp');
const { extractModelFromZip } = require('../core/zip-entries');
const { libraryPathAllowed } = require('./path-context');

/** Content types of the model files both routes send; others go without one. */
const MODEL_MIME_TYPES = {
  '.stl': 'application/octet-stream',
  '.3mf': 'application/octet-stream',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.obj': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.step': 'application/octet-stream',
  '.stp': 'application/octet-stream',
  '.3ds': 'application/octet-stream',
  '.amf': 'application/octet-stream',
  '.dae': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.x3d': 'application/octet-stream',
  '.blender': 'application/octet-stream',
  '.dxf': 'application/octet-stream',
  '.dwg': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.f3d': 'application/octet-stream',
  '.f3z': 'application/octet-stream',
  '.chitubox': 'application/octet-stream',
  '.voxl': 'application/octet-stream',
  '.gcode': 'application/octet-stream',
  '.igs': 'application/octet-stream',
  '.iges': 'application/octet-stream',
  '.lys': 'application/octet-stream',
  '.lyt': 'application/octet-stream'
};

function registerLibraryFileRoutes(expressApp) {
  // Serve files via HTTP for server mode (UNC paths or Docker-mounted paths)
  expressApp.get('/api/file/*', (req, res) => {
    try {
      // Extract file path from URL (everything after /api/file/)
      const filePath = decodeURIComponent(req.path.replace('/api/file/', ''));
      if (!libraryPathAllowed(filePath)) {
        res.status(403).send('File is outside the library folders');
        return;
      }

      // Library paths are absolute container paths. A client path (e.g. C:\ from another computer) is not on the server.
      if (!filePath.startsWith('/')) {
        res.status(404).setHeader('X-File-Not-On-Server', '1').send('File not in the JusttPrint backend (the path is on another computer).');
        return;
      }

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        res.status(404).send('File not found');
        return;
      }

      // Set appropriate content type
      const ext = path.extname(filePath).toLowerCase();

      if (MODEL_MIME_TYPES[ext]) {
        res.setHeader('Content-Type', MODEL_MIME_TYPES[ext]);
      }

      // Stream the file
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      fileStream.on('error', (error) => {
        console.error('Error serving file:', error);
        if (!res.headersSent) {
          res.status(500).send('Error reading file');
        }
      });
    } catch (error) {
      console.error('Error in file serving endpoint:', error);
      res.status(500).send('Error serving file');
    }
  });

  // Download endpoint for server mode - handles both regular files and zip entries
  expressApp.get('/api/download/*', async (req, res) => {
    try {
      // Extract file path from URL (everything after /api/download/)
      const filePath = decodeURIComponent(req.path.replace('/api/download/', ''));

      // Check if this is a zip entry
      const pathInfo = parseZipPath(filePath);
      if (!libraryPathAllowed(pathInfo.isZipEntry ? pathInfo.zipPath : filePath)) {
        res.status(403).send('File is outside the library folders');
        return;
      }
      let actualFilePath = filePath;
      let fileName = path.basename(filePath);

      if (pathInfo.isZipEntry) {
        // Extract zip entry to temp file and stream it
        try {
          const tempPath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
          actualFilePath = tempPath;
          fileName = path.basename(pathInfo.entryPath);
        } catch (error) {
          console.error('Error extracting zip entry:', error);
          res.status(500).send('Error extracting file from zip');
          return;
        }
      }

      // Library, backup and extract-temp paths are all absolute container paths.
      if (!actualFilePath.startsWith('/')) {
        res.status(400).send('Invalid path: expected an absolute path');
        return;
      }

      // Check if file exists
      if (!fs.existsSync(actualFilePath)) {
        res.status(404).send('File not found');
        return;
      }

      // Set appropriate content type
      const ext = path.extname(fileName).toLowerCase();

      if (MODEL_MIME_TYPES[ext]) {
        res.setHeader('Content-Type', MODEL_MIME_TYPES[ext]);
      }

      // Set Content-Disposition header to trigger download with proper filename
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

      // Stream the file
      const fileStream = fs.createReadStream(actualFilePath);
      fileStream.pipe(res);

      fileStream.on('error', (error) => {
        console.error('Error serving download:', error);
        if (!res.headersSent) {
          res.status(500).send('Error reading file');
        }
      });

      // Clean up temp file after streaming (for zip entries)
      if (pathInfo.isZipEntry) {
        fileStream.on('end', () => {
          setTimeout(() => {
            cleanupExtractTempFile(actualFilePath).catch(() => {});
          }, 1000);
        });
      }
    } catch (error) {
      console.error('Error in download endpoint:', error);
      res.status(500).send('Error serving download');
    }
  });
}

module.exports = { MODEL_MIME_TYPES, registerLibraryFileRoutes };
