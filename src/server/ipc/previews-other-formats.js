'use strict';

/** Pictures stored inside LYS (Lychee), F3D/F3Z (Fusion), Chitubox and VOXL files, for the details panel. */

const { ipcMain } = require('../runtime');
const fs = require('fs');
const path = require('path');
const { isUrlModel, parseZipPath } = require('../../core/library-paths');
const { extractModelFromZip, isMacOsResourceForkEntry } = require('../../core/zip-entries');
const { extractLysPreviewEntry } = require('../../core/extract-lys-preview');
const { extractF3dPreviewEntry } = require('../../core/extract-f3d-preview');
const { extractChituboxPreviewEntry } = require('../../core/extract-chitubox-preview');
const { extractVoxlPreviewEntry } = require('../../core/extract-voxl-preview');

ipcMain.handle('getLYSImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  if (/[\\/]__macosx[\\/]/i.test(filePath)) {
    return [];
  }

  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;

  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }

  if (pathInfo.isZipEntry) {
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for LYS preview:', error);
      return [];
    }
  }

  try {
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }

    const data = await fs.promises.readFile(actualFilePath);
    const entry = extractLysPreviewEntry(new Uint8Array(data));
    if (!entry || !entry.bytes || !entry.bytes.length) {
      return [];
    }

    const ext =
      path
        .extname(entry.name || '')
        .toLowerCase()
        .replace(/^\./, '') || 'png';
    const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' };
    const mimeType = mimeMap[ext] || 'png';
    const dataUrl = `data:image/${mimeType};base64,${Buffer.from(entry.bytes).toString('base64')}`;
    return [dataUrl];
  } catch (error) {
    console.error('Error reading LYS preview:', error);
    return [];
  }
});

ipcMain.handle('getF3DImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  if (/[\\/]__macosx[\\/]/i.test(filePath)) {
    return [];
  }

  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;

  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }

  if (pathInfo.isZipEntry) {
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for F3D preview:', error);
      return [];
    }
  }

  let fh;
  try {
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }

    fh = await fs.promises.open(actualFilePath, 'r');
    const { size } = await fh.stat();
    const handle = fh;
    const entry = await extractF3dPreviewEntry({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        return new Uint8Array(buf.subarray(0, bytesRead));
      }
    });
    if (!entry || !entry.bytes || !entry.bytes.length) {
      return [];
    }

    const ext =
      path
        .extname(entry.name || '')
        .toLowerCase()
        .replace(/^\./, '') || 'png';
    const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' };
    const mimeType = mimeMap[ext] || 'png';
    const dataUrl = `data:image/${mimeType};base64,${Buffer.from(entry.bytes).toString('base64')}`;
    return [dataUrl];
  } catch (error) {
    console.error('Error reading F3D preview:', error);
    return [];
  } finally {
    await fh?.close();
  }
});

ipcMain.handle('getChituboxImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  if (/[\\/]__macosx[\\/]/i.test(filePath)) {
    return [];
  }

  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;

  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }

  if (pathInfo.isZipEntry) {
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for ChiTuBox preview:', error);
      return [];
    }
  }

  try {
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }

    const data = await fs.promises.readFile(actualFilePath);
    const entry = extractChituboxPreviewEntry(new Uint8Array(data));
    if (!entry || !entry.bytes || !entry.bytes.length) {
      return [];
    }

    const dataUrl = `data:image/png;base64,${Buffer.from(entry.bytes).toString('base64')}`;
    return [dataUrl];
  } catch (error) {
    console.error('Error reading ChiTuBox preview:', error);
    return [];
  }
});

ipcMain.handle('getVoxlImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  if (/[\\/]__macosx[\\/]/i.test(filePath)) {
    return [];
  }

  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;

  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }

  if (pathInfo.isZipEntry) {
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for VOXL preview:', error);
      return [];
    }
  }

  let fh;
  try {
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }

    fh = await fs.promises.open(actualFilePath, 'r');
    const { size } = await fh.stat();
    const handle = fh;
    const entry = await extractVoxlPreviewEntry({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        return new Uint8Array(buf.subarray(0, bytesRead));
      }
    });
    if (!entry || !entry.bytes || !entry.bytes.length) {
      return [];
    }

    const mime = (entry.mimeType || 'image/png').toLowerCase();
    const mimeType = mime.includes('jpeg') || mime.includes('jpg') ? 'jpeg' : mime.includes('webp') ? 'webp' : 'png';
    const dataUrl = `data:image/${mimeType};base64,${Buffer.from(entry.bytes).toString('base64')}`;
    return [dataUrl];
  } catch (error) {
    console.error('Error reading VOXL preview:', error);
    return [];
  } finally {
    await fh?.close();
  }
});
