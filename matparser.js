// Pure-JS parser for MATLAB MAT-file level 5 format (v5/v6/v7, including
// compressed v7). Detects (but does not parse) v7.3 (HDF5-based) files.
// No external dependencies except an injected zlib-inflate function for
// miCOMPRESSED elements (see `inflate` option).
//
// Supports: numeric matrices (double/single/int8..64/uint8..64), logical,
// char (converted to strings), complex numbers (real part only is exported
// to CSV; both parts are returned). Does NOT support cell arrays, struct
// arrays, sparse matrices, function handles, or objects — these are
// reported with unsupported:true so the caller can show a clear message.
//
// Only 2-D (or 1-D-as-2-D) arrays can be usefully exported to CSV; N-D
// arrays (ndims > 2) are flagged tooManyDims:true.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MatParser = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MI = {
    INT8: 1, UINT8: 2, INT16: 3, UINT16: 4, INT32: 5, UINT32: 6,
    SINGLE: 7, DOUBLE: 9, INT64: 12, UINT64: 13, MATRIX: 14,
    COMPRESSED: 15, UTF8: 16, UTF16: 17, UTF32: 18,
  };

  var MX = {
    CELL_CLASS: 1, STRUCT_CLASS: 2, OBJECT_CLASS: 3, CHAR_CLASS: 4,
    SPARSE_CLASS: 5, DOUBLE_CLASS: 6, SINGLE_CLASS: 7, INT8_CLASS: 8,
    UINT8_CLASS: 9, INT16_CLASS: 10, UINT16_CLASS: 11, INT32_CLASS: 12,
    UINT32_CLASS: 13, INT64_CLASS: 14, UINT64_CLASS: 15, FUNCTION_CLASS: 16,
  };

  var MX_CLASS_NAMES = {};
  MX_CLASS_NAMES[MX.CELL_CLASS] = "cell";
  MX_CLASS_NAMES[MX.STRUCT_CLASS] = "struct";
  MX_CLASS_NAMES[MX.OBJECT_CLASS] = "object";
  MX_CLASS_NAMES[MX.CHAR_CLASS] = "char";
  MX_CLASS_NAMES[MX.SPARSE_CLASS] = "sparse";
  MX_CLASS_NAMES[MX.DOUBLE_CLASS] = "double";
  MX_CLASS_NAMES[MX.SINGLE_CLASS] = "single";
  MX_CLASS_NAMES[MX.INT8_CLASS] = "int8";
  MX_CLASS_NAMES[MX.UINT8_CLASS] = "uint8";
  MX_CLASS_NAMES[MX.INT16_CLASS] = "int16";
  MX_CLASS_NAMES[MX.UINT16_CLASS] = "uint16";
  MX_CLASS_NAMES[MX.INT32_CLASS] = "int32";
  MX_CLASS_NAMES[MX.UINT32_CLASS] = "uint32";
  MX_CLASS_NAMES[MX.INT64_CLASS] = "int64";
  MX_CLASS_NAMES[MX.UINT64_CLASS] = "uint64";
  MX_CLASS_NAMES[MX.FUNCTION_CLASS] = "function_handle";

  var UNSUPPORTED_CLASSES = {};
  [MX.CELL_CLASS, MX.STRUCT_CLASS, MX.OBJECT_CLASS, MX.SPARSE_CLASS, MX.FUNCTION_CLASS]
    .forEach(function (c) { UNSUPPORTED_CLASSES[c] = true; });

  function readUint32(dv, off) { return dv.getUint32(off, true); }
  function readInt32(dv, off) { return dv.getInt32(off, true); }
  function readUint16(dv, off) { return dv.getUint16(off, true); }

  // Reads one tag (either full 8-byte tag or small-element-format tag) at
  // `off` within `dv`. Returns {mdtype, byteCount, dataOffset, totalSize}.
  function readTag(dv, off) {
    var w0 = readUint32(dv, off);
    var upper = (w0 >>> 16) & 0xffff;
    if (upper !== 0) {
      // small data element format
      var mdtype = w0 & 0xffff;
      var byteCount = upper;
      return { mdtype: mdtype, byteCount: byteCount, dataOffset: off + 4, totalSize: 8 };
    }
    var mdtype2 = w0;
    var byteCount2 = readUint32(dv, off + 4);
    var padded = byteCount2 + ((8 - (byteCount2 % 8)) % 8);
    // miCOMPRESSED elements are, unlike every other data element, NOT
    // padded to an 8-byte boundary on disk (observed directly in real
    // files written by MATLAB/scipy — the next tag follows immediately
    // after the raw compressed byte count, with no trailing zero pad).
    var unpaddedTotal = 8 + byteCount2;
    var paddedTotal = 8 + padded;
    return {
      mdtype: mdtype2, byteCount: byteCount2, dataOffset: off + 8,
      totalSize: mdtype2 === MI.COMPRESSED ? unpaddedTotal : paddedTotal,
    };
  }

  // Reads the numeric payload of a tag as a plain JS array of numbers
  // (BigInt64/BigUint64 are converted to Number, which loses precision
  // above 2^53 but is fine for CSV display purposes).
  function readNumericPayload(buf, dv, tag) {
    var off = tag.dataOffset, n = tag.byteCount;
    switch (tag.mdtype) {
      case MI.INT8: return Array.from(new Int8Array(buf, off, n));
      case MI.UINT8: return Array.from(new Uint8Array(buf, off, n));
      case MI.INT16: return Array.from(new Int16Array(buf, off, n / 2));
      case MI.UINT16: return Array.from(new Uint16Array(buf, off, n / 2));
      case MI.INT32: return Array.from(new Int32Array(buf, off, n / 4));
      case MI.UINT32: return Array.from(new Uint32Array(buf, off, n / 4));
      case MI.SINGLE: return Array.from(new Float32Array(buf, off, n / 4));
      case MI.DOUBLE: return Array.from(new Float64Array(buf, off, n / 8));
      case MI.INT64: {
        var bi = new BigInt64Array(buf, off, n / 8);
        return Array.from(bi, function (x) { return Number(x); });
      }
      case MI.UINT64: {
        var bu = new BigUint64Array(buf, off, n / 8);
        return Array.from(bu, function (x) { return Number(x); });
      }
      case MI.UTF16: return Array.from(new Uint16Array(buf, off, n / 2));
      case MI.UTF8: return Array.from(new Uint8Array(buf, off, n));
      case MI.UTF32: return Array.from(new Uint32Array(buf, off, n / 4));
      default: throw new Error("unsupported data mdtype " + tag.mdtype);
    }
  }

  // Parses the body of a miMATRIX element (the bytes strictly inside its
  // outer tag). `buf` is the underlying ArrayBuffer, `start`/`end` the byte
  // range of the matrix body within it.
  function parseMatrixBody(buf, start, end) {
    var dv = new DataView(buf, start, end - start);
    var off = 0;

    // 1. array flags (tag mdtype should be UINT32, byteCount 8)
    var flagsTag = readTag(dv, off);
    var flagsWord = readUint32(dv, flagsTag.dataOffset);
    var mclass = flagsWord & 0xff;
    var isLogical = !!((flagsWord >> 9) & 1);
    var isGlobal = !!((flagsWord >> 10) & 1);
    var isComplex = !!((flagsWord >> 11) & 1);
    off += flagsTag.totalSize;

    // 2. dimensions array
    var dimsTag = readTag(dv, off);
    var dims = [];
    for (var i = 0; i < dimsTag.byteCount; i += 4) {
      dims.push(readInt32(dv, dimsTag.dataOffset + i));
    }
    off += dimsTag.totalSize;

    // 3. array name (dv's offsets are relative to `start`, so read the
    // absolute bytes directly from `buf` rather than via readNameString).
    var nameTag = readTag(dv, off);
    var name = "";
    var nameBytes = new Uint8Array(buf, start + nameTag.dataOffset, nameTag.byteCount);
    for (var k = 0; k < nameBytes.length; k++) {
      if (nameBytes[k] === 0) break;
      name += String.fromCharCode(nameBytes[k]);
    }
    off += nameTag.totalSize;

    var result = {
      name: name, mclass: mclass, className: MX_CLASS_NAMES[mclass] || ("class" + mclass),
      dims: dims, isLogical: isLogical, isGlobal: isGlobal, isComplex: isComplex,
    };

    if (UNSUPPORTED_CLASSES[mclass]) {
      result.unsupported = true;
      return result;
    }

    var numel = dims.reduce(function (a, b) { return a * b; }, 1);
    if (dims.length > 2) {
      result.tooManyDims = true;
      return result;
    }

    // 4. real data
    var realTag = readTag(dv, off);
    var realAbs = { mdtype: realTag.mdtype, byteCount: realTag.byteCount, dataOffset: start + realTag.dataOffset };
    var real = readNumericPayload(buf, dv, realAbs);
    off += realTag.totalSize;

    var imag = null;
    if (isComplex && off < (end - start)) {
      var imagTag = readTag(dv, off);
      var imagAbs = { mdtype: imagTag.mdtype, byteCount: imagTag.byteCount, dataOffset: start + imagTag.dataOffset };
      imag = readNumericPayload(buf, dv, imagAbs);
    }

    result.real = real;
    result.imag = imag;
    result.numel = numel;

    if (mclass === MX.CHAR_CLASS) {
      // dims = [nrows, ncols]; column-major; each row is one string.
      var nrows = dims[0] || 0, ncols = dims[1] || 1;
      var strings = [];
      for (var r = 0; r < nrows; r++) {
        var s2 = "";
        for (var c = 0; c < ncols; c++) {
          var code = real[r + c * nrows];
          if (code !== 0) s2 += String.fromCharCode(code);
        }
        strings.push(s2);
      }
      result.strings = strings;
    }

    return result;
  }

  // Reshapes a flat column-major `data` array with shape `dims` ([rows,cols]
  // or [n]) into an array of rows (row-major), for CSV export / preview.
  function toRowMajor2D(data, dims) {
    if (dims.length === 1) {
      return data.map(function (v) { return [v]; });
    }
    var rows = dims[0], cols = dims[1];
    var out = new Array(rows);
    for (var r = 0; r < rows; r++) {
      var row = new Array(cols);
      for (var c = 0; c < cols; c++) row[c] = data[r + c * rows];
      out[r] = row;
    }
    return out;
  }

  var HDF5_MAGIC = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

  function isHDF5(buf) {
    var b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    if (b.length < 8) return false;
    for (var i = 0; i < 8; i++) if (b[i] !== HDF5_MAGIC[i]) return false;
    return true;
  }

  // Parses a full MAT file. `inflate(Uint8Array) -> Uint8Array` must be
  // supplied to handle miCOMPRESSED elements (zlib inflate).
  function parse(buf, inflate) {
    if (isHDF5(buf)) {
      return { isV73: true, variables: [] };
    }
    if (buf.byteLength < 128) {
      throw new Error("file too small to be a MAT-file");
    }
    var headerView = new DataView(buf, 0, 128);
    // The endian indicator is conventionally described as the two chars 'M'
    // then 'I' (0x4D, 0x49) for a little-endian file, but the correct test
    // (per the format spec, and what real MATLAB files contain on disk) is
    // to read the two bytes as a little-endian uint16 and compare against
    // 0x4D49 ("MI") — this is NOT the same as the raw on-disk byte order,
    // which for a little-endian file is actually 0x49 ('I') then 0x4D ('M').
    var endianVal = readUint16(headerView, 126);
    var littleEndian = endianVal === 0x4d49;
    var bigEndian = endianVal === 0x494d;
    if (!littleEndian) {
      if (bigEndian) throw new Error("big-endian MAT-files are not supported");
      throw new Error("not a recognized MAT-file (bad endian indicator)");
    }
    var textBytes = new Uint8Array(buf, 0, 116);
    var text = "";
    for (var i = 0; i < textBytes.length; i++) {
      if (textBytes[i] === 0) break;
      text += String.fromCharCode(textBytes[i]);
    }

    var variables = [];
    var off = 128;
    var view = new DataView(buf);
    while (off < buf.byteLength - 8) {
      var tag = readTag(view, off);
      if (tag.mdtype === MI.COMPRESSED) {
        // A single miCOMPRESSED element's decompressed payload can itself
        // contain a whole sequence of top-level elements (MATLAB typically
        // compresses the entire post-header data section as one blob), so
        // this must loop just like the outer file-level loop, not assume
        // exactly one inner element.
        var compressed = new Uint8Array(buf, tag.dataOffset, tag.byteCount);
        var inflated = inflate(compressed);
        var innerBuf = inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + inflated.byteLength);
        var innerView = new DataView(innerBuf);
        var innerOff = 0;
        while (innerOff < innerBuf.byteLength - 8) {
          var innerTag = readTag(innerView, innerOff);
          if (innerTag.mdtype === MI.MATRIX) {
            var mat = parseMatrixBody(innerBuf, innerTag.dataOffset, innerTag.dataOffset + innerTag.byteCount);
            if (mat.name && mat.name.indexOf("__") !== 0) variables.push(mat);
          }
          innerOff += innerTag.totalSize;
        }
      } else if (tag.mdtype === MI.MATRIX) {
        var mat2 = parseMatrixBody(buf, tag.dataOffset, tag.dataOffset + tag.byteCount);
        if (mat2.name && mat2.name.indexOf("__") !== 0) variables.push(mat2);
      }
      off += tag.totalSize;
    }

    return { isV73: false, text: text, variables: variables };
  }

  return {
    parse: parse,
    isHDF5: isHDF5,
    toRowMajor2D: toRowMajor2D,
    MI: MI,
    MX: MX,
  };
});
