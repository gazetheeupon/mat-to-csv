(function () {
  "use strict";

  var PREVIEW_ROWS = 50;
  var PREVIEW_COLS = 20;
  var MAX_CSV_CELLS = 8000000;

  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  var fnameEl = document.getElementById("fname");
  var statusEl = document.getElementById("status");
  var varsCard = document.getElementById("varsCard");
  var varsHeading = document.getElementById("varsHeading");
  var varsBody = document.getElementById("varsBody");
  var previewCard = document.getElementById("previewCard");
  var previewHeading = document.getElementById("previewHeading");
  var previewTable = document.getElementById("previewTable");
  var truncNote = document.getElementById("truncNote");
  var exportBtn = document.getElementById("exportBtn");
  var exportStatusEl = document.getElementById("exportStatus");

  var variables = []; // [{name, className, dims, ..., error?, table?}]
  var selectedIndex = -1;

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.className = isError ? "error" : "";
  }

  function setExportStatus(msg, isWarn) {
    exportStatusEl.textContent = msg || "";
    exportStatusEl.className = isWarn ? "warn" : "";
  }

  function resetUI() {
    varsCard.style.display = "none";
    previewCard.style.display = "none";
    varsBody.innerHTML = "";
    previewTable.innerHTML = "";
    truncNote.textContent = "";
    setExportStatus("");
    variables = [];
    selectedIndex = -1;
  }

  function describeShape(dims) {
    return "(" + dims.join(", ") + ")";
  }

  function annotateVariable(v) {
    // Attach a human `error` string for anything we can't turn into a table,
    // and a `table` builder for anything we can.
    if (v.unsupported) {
      v.error = v.className + " arrays aren't supported for CSV export (only numeric, logical, and char arrays are).";
      return v;
    }
    if (v.tooManyDims) {
      v.error = "This is a " + v.dims.length + "-D array " + describeShape(v.dims) + " — only 2-D matrices (and vectors) can be exported to CSV here.";
      return v;
    }
    if (v.mclass === MatParser.MX.CHAR_CLASS) {
      v.table = buildStringTable(v);
    } else {
      v.table = buildNumericTable(v);
      if (v.isComplex) {
        v.complexNote = "This array is complex — only the real part is exported; the imaginary part is discarded.";
      }
    }
    return v;
  }

  function buildNumericTable(v) {
    var rowMajor = MatParser.toRowMajor2D(v.real, v.dims);
    var rows = v.dims[0] || rowMajor.length;
    var cols = v.dims.length > 1 ? v.dims[1] : 1;
    var colHeaders = [];
    for (var c = 0; c < cols; c++) colHeaders.push("col" + c);
    return {
      rows: rows,
      cols: cols,
      colHeaders: colHeaders,
      getCell: function (r, c) {
        var val = rowMajor[r][c];
        if (v.isLogical) return val ? "TRUE" : "FALSE";
        return val;
      },
    };
  }

  function buildStringTable(v) {
    var strings = v.strings || [];
    return {
      rows: strings.length,
      cols: 1,
      colHeaders: ["text"],
      getCell: function (r) { return strings[r]; },
    };
  }

  function handleFile(file) {
    resetUI();
    fnameEl.textContent = file.name;
    setStatus("Reading file...");

    file.arrayBuffer().then(function (buffer) {
      if (typeof window.fflateUnzlibSync !== "function") {
        setStatus("The decompression helper failed to load. Try reloading the page.", true);
        return;
      }
      var parsed;
      try {
        parsed = MatParser.parse(buffer, function (bytes) { return window.fflateUnzlibSync(bytes); });
      } catch (e) {
        setStatus("Could not read this as a MAT-file: " + e.message, true);
        return;
      }

      if (parsed.isV73) {
        setStatus(
          "This is a MATLAB v7.3 file, which is actually an HDF5 file under the hood — a different format this page doesn't parse yet. " +
          "In MATLAB, re-save with save(\"file.mat\", \"-v7\") for a format this page can open, or use Python's h5py/scipy.io to read it directly.",
          true
        );
        return;
      }

      if (parsed.variables.length === 0) {
        setStatus("No readable variables were found in this MAT-file.", true);
        return;
      }

      variables = parsed.variables.map(annotateVariable);
      setStatus("");
      renderVarsTable();
      varsCard.style.display = "";
      varsHeading.textContent = variables.length > 1 ? "Variables (" + variables.length + ")" : "Variable";
      var firstGood = variables.findIndex(function (v) { return !v.error; });
      if (firstGood >= 0) selectVariable(firstGood);
    }).catch(function (e) {
      setStatus("Could not read file: " + e.message, true);
    });
  }

  function renderVarsTable() {
    varsBody.innerHTML = "";
    variables.forEach(function (v, i) {
      var tr = document.createElement("tr");
      tr.className = "var-row" + (v.error ? " errored" : "");
      if (v.error) {
        tr.innerHTML = "<td>" + escapeHtml(v.name) + "</td><td colspan=\"3\">" + escapeHtml(v.error) + "</td>";
      } else {
        tr.innerHTML = "<td>" + escapeHtml(v.name) + "</td><td>" + escapeHtml(v.className) +
          (v.isComplex ? " (complex)" : "") + "</td><td>" + describeShape(v.dims) + "</td><td>" +
          v.numel.toLocaleString() + "</td>";
        tr.addEventListener("click", function () { selectVariable(i); });
      }
      varsBody.appendChild(tr);
    });
  }

  function selectVariable(i) {
    var v = variables[i];
    if (!v || v.error) return;
    selectedIndex = i;
    Array.prototype.forEach.call(varsBody.children, function (tr, idx) {
      tr.classList.toggle("selected", idx === i);
    });

    previewCard.style.display = "";
    previewHeading.textContent = "Preview: " + v.name + " — " + v.className + " " + describeShape(v.dims);
    renderPreview(v.table);
    setExportStatus(v.complexNote || "", !!v.complexNote);
    exportBtn.disabled = false;
  }

  function renderPreview(table) {
    var rShown = Math.min(table.rows, PREVIEW_ROWS);
    var cShown = Math.min(table.cols, PREVIEW_COLS);

    var html = "<thead><tr><th></th>";
    for (var c = 0; c < cShown; c++) html += "<th>" + escapeHtml(table.colHeaders[c]) + "</th>";
    html += "</tr></thead><tbody>";
    for (var r = 0; r < rShown; r++) {
      html += "<tr><th>" + r + "</th>";
      for (var c2 = 0; c2 < cShown; c2++) {
        html += "<td>" + escapeHtml(formatCell(table.getCell(r, c2))) + "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody>";
    previewTable.innerHTML = html;

    var notes = [];
    if (table.rows > rShown) notes.push("showing first " + rShown + " of " + table.rows + " rows");
    if (table.cols > cShown) notes.push("first " + cShown + " of " + table.cols + " columns");
    truncNote.textContent = notes.length ? "(" + notes.join(", ") + " — full data is included in the CSV export)" : "";
  }

  function formatCell(v) {
    if (typeof v === "number" && !Number.isInteger(v)) return String(v);
    return String(v);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }

  function csvEscape(v) {
    var s = formatCell(v);
    if (/[",\n\r]/.test(s)) return "\"" + s.replace(/"/g, "\"\"") + "\"";
    return s;
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  exportBtn.addEventListener("click", function () {
    var v = variables[selectedIndex];
    if (!v || !v.table) return;
    var rows = v.table.rows, cols = v.table.cols, colHeaders = v.table.colHeaders, getCell = v.table.getCell;
    var totalCells = rows * cols;

    if (totalCells > MAX_CSV_CELLS) {
      setExportStatus(
        "This variable has " + totalCells.toLocaleString() + " cells, above the " + MAX_CSV_CELLS.toLocaleString() + "-cell export limit. " +
        "Try a smaller variable, or select a different one.",
        true
      );
      return;
    }
    if (totalCells > 1000000) {
      var ok = window.confirm(
        "This will export " + totalCells.toLocaleString() + " cells (" + rows.toLocaleString() + " rows x " + cols.toLocaleString() + " cols). " +
        "That may take a moment and produce a large file. Continue?"
      );
      if (!ok) return;
    }

    setExportStatus("Building CSV...");
    setTimeout(function () {
      var lines = [];
      lines.push(["row"].concat(colHeaders).map(csvEscape).join(","));
      for (var r = 0; r < rows; r++) {
        var row = [r];
        for (var c = 0; c < cols; c++) row.push(getCell(r, c));
        lines.push(row.map(csvEscape).join(","));
      }
      var csv = lines.join("\r\n") + "\r\n";
      var blob = new Blob([csv], { type: "text/csv" });
      downloadBlob(blob, v.name.replace(/[^a-z0-9_.-]+/gi, "_") + ".csv");
      setExportStatus("Exported " + rows.toLocaleString() + " rows x " + cols.toLocaleString() + " cols.");
    }, 10);
  });

  // ---- file input wiring ----
  dropzone.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove("drag"); });
  });
  dropzone.addEventListener("drop", function (e) {
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
})();
