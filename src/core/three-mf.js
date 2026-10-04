'use strict';

const database = require('./database');
const fs = require('fs');
const { parseZipPath } = require('./library-paths');
const { extractModelFromZip, find3dModelZipEntry, isLikelyValidZipBuffer, isMacOsResourceForkEntry, openZip } = require('./zip-entries');

// Helper function to clean HTML entities and special characters from description text
function cleanDescriptionText(text) {
  if (!text) return text;
  
  let cleaned = text;
  
  // First, decode double-encoded HTML entities (e.g., &amp;lt; becomes &lt;, &amp;#34; becomes &#34;)
  // This handles cases where entities are encoded multiple times
  let previousCleaned = '';
  while (cleaned !== previousCleaned) {
    previousCleaned = cleaned;
    cleaned = cleaned.replace(/&amp;(#?\w+;)/g, '&$1');
  }
  
  // Decode common HTML entities
  cleaned = cleaned.replace(/&lt;/g, '<');
  cleaned = cleaned.replace(/&gt;/g, '>');
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#34;/g, '"');
  cleaned = cleaned.replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/&apos;/g, "'");
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  cleaned = cleaned.replace(/&#160;/g, ' ');
  cleaned = cleaned.replace(/&amp;/g, '&');
  
  // Remove HTML tags (including nested tags and multiline)
  cleaned = cleaned.replace(/<[^>]*>/g, '');
  
  // Decode any remaining numeric entities (decimal and hexadecimal)
  cleaned = cleaned.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
  cleaned = cleaned.replace(/&#x([0-9a-fA-F]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  
  // Clean up whitespace - replace multiple spaces/newlines/tabs with single space
  cleaned = cleaned.replace(/\s+/g, ' ');
  
  // Trim leading/trailing whitespace
  cleaned = cleaned.trim();
  
  return cleaned;
}

// Helper function to parse 3MF model XML and extract metadata
function parse3MFModelXML(xmlContent) {
  const metadata = {
    designer: null,
    parentModel: null,
    notes: null,
    license: null
  };

  try {
    // Match <metadata ...> regardless of attribute order (some writers put type before name)
    const metadataPattern = /<metadata\b([^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/metadata>/gi;
    let match;

    while ((match = metadataPattern.exec(xmlContent)) !== null) {
      const attrChunk = match[1];
      const nameMatch = attrChunk.match(/\bname\s*=\s*["']([^"']+)["']/i);
      if (!nameMatch) continue;
      const fieldName = nameMatch[1].trim();
      let fieldValue = match[2].trim();
      
      // If the value is in a CDATA section, it's already extracted by the regex
      // Otherwise, handle any remaining encoding

      // Map XML metadata names to database fields
      if (fieldName === 'Designer' && fieldValue) {
        metadata.designer = fieldValue;
      } else if (fieldName === 'Title' && fieldValue) {
        metadata.parentModel = fieldValue;
      } else if (fieldName === 'Description' && fieldValue) {
        metadata.notes = cleanDescriptionText(fieldValue);
      } else if (fieldName === 'License' && fieldValue) {
        metadata.license = fieldValue;
      }
    }
  } catch (error) {
    console.error('Error parsing 3MF model XML:', error);
  }

  return metadata;
}

// Helper function to filter 3MF metadata based on user settings
function filter3MFMetadataBySettings(metadata) {
  const filtered = {
    designer: null,
    parentModel: null,
    notes: null,
    license: null
  };
  
  try {
    // Get settings from database (default to '1' if not set)
    const enableDesigner = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enable3MFDesigner');
    const enableParentModel = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enable3MFParentModel');
    const enableLicense = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enable3MFLicense');
    const enableNotes = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enable3MFNotes');
    
    // Include field if setting is '1' or not set (default enabled)
    if (metadata.designer && (enableDesigner?.value === '1' || !enableDesigner)) {
      filtered.designer = metadata.designer;
    }
    if (metadata.parentModel && (enableParentModel?.value === '1' || !enableParentModel)) {
      filtered.parentModel = metadata.parentModel;
    }
    if (metadata.license && (enableLicense?.value === '1' || !enableLicense)) {
      filtered.license = metadata.license;
    }
    if (metadata.notes && (enableNotes?.value === '1' || !enableNotes)) {
      filtered.notes = metadata.notes;
    }
  } catch (error) {
    console.error('Error filtering 3MF metadata by settings:', error);
    // On error, return original metadata (fail open)
    return metadata;
  }
  
  return filtered;
}

// Helper function to extract metadata from a 3MF file
async function extract3MFMetadata(filePath) {
  try {
    // Check if this is a zip entry
    const pathInfo = parseZipPath(filePath);
    let actualFilePath = filePath;
    let shouldCleanup = false;
    
    if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
      return null;
    }
    
    if (pathInfo.isZipEntry) {
      // Extract to temp file first
      try {
        actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
        shouldCleanup = true;
      } catch (error) {
        console.error('Error extracting zip entry for 3MF metadata:', error);
        return null;
      }
    }
    
    // Check if file exists
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return null;
    }
    
    const data = await fs.promises.readFile(actualFilePath);
    if (!isLikelyValidZipBuffer(data)) {
      return null;
    }
    
    // A 3MF file is a zip
    let contents;
    try {
      contents = openZip(data);
    } catch (zipError) {
      return null;
    }
    
    const modelXmlFile = find3dModelZipEntry(contents);
    
    if (modelXmlFile && !modelXmlFile.dir) {
      const xmlContent = modelXmlFile.read('string');
      const parsedMetadata = parse3MFModelXML(xmlContent);
      
      // Clean up temp file if needed
      if (shouldCleanup && actualFilePath !== filePath) {
        try {
          await fs.promises.unlink(actualFilePath);
        } catch (cleanupError) {
          console.error('Error cleaning up temp file:', cleanupError);
        }
      }
      
      return parsedMetadata;
    } else {
      // Clean up temp file if needed
      if (shouldCleanup && actualFilePath !== filePath) {
        try {
          await fs.promises.unlink(actualFilePath);
        } catch (cleanupError) {
          console.error('Error cleaning up temp file:', cleanupError);
        }
      }
      return null;
    }
  } catch (error) {
    console.error('Error extracting 3MF metadata:', error);
    return null;
  }
}

module.exports = { extract3MFMetadata, filter3MFMetadataBySettings, parse3MFModelXML };
