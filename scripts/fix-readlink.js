/**
 * Node 24 + Windows readlink fix.
 * readlinkSync on regular files throws EISDIR on Windows with Node 24,
 * but webpack/Next.js expects EINVAL. This shim converts the error code.
 * Loaded via NODE_OPTIONS="--require ./scripts/fix-readlink.js"
 */
const fs = require("fs");

function fixCode(err) {
  if (err && err.code === "EISDIR") {
    err.code = "EINVAL";
    err.errno = -4071;
  }
  return err;
}

// Patch sync version
const _origSync = fs.readlinkSync;
fs.readlinkSync = function patchedReadlinkSync() {
  try {
    return _origSync.apply(fs, arguments);
  } catch (err) {
    throw fixCode(err);
  }
};

// Patch callback version
const _origAsync = fs.readlink;
fs.readlink = function patchedReadlink() {
  const args = Array.from(arguments);
  const cb = args.pop();
  args.push(function (err, linkString) {
    cb(fixCode(err), linkString);
  });
  return _origAsync.apply(fs, args);
};

// Patch promises version (used by newer Next.js internals)
const fsp = fs.promises;
if (fsp && fsp.readlink) {
  const _origPromise = fsp.readlink.bind(fsp);
  fsp.readlink = async function patchedReadlinkPromise() {
    try {
      return await _origPromise.apply(fsp, arguments);
    } catch (err) {
      throw fixCode(err);
    }
  };
}
