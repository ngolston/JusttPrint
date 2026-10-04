'use strict';

/** JSON for WebSocket messages; typed arrays (mesh data) become plain arrays. */
function jsonStringifyForWs(payload) {
  return JSON.stringify(payload, (_key, value) => {
    if (ArrayBuffer.isView(value)) {
      return Array.from(value);
    }
    return value;
  });
}

module.exports = { jsonStringifyForWs };
