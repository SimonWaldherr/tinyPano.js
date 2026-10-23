(function () {
  'use strict';

  var DATABASE = 'tinyPanoTourStudio';
  var STORE = 'drafts';
  var KEY = 'current';
  var METADATA_KEY = 'tinyPano.draft.meta';
  var TIMEOUT = 5000;
  var own = Object.prototype.hasOwnProperty;

  function failure(code, message, cause) {
    var error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function validate(project) {
    if (!project || project.format !== 'tinyPano-project' || project.version !== 1 || typeof project.title !== 'string' ||
        typeof project.firstScene !== 'string' || !Array.isArray(project.scenes) || !project.scenes.length) {
      throw failure('DRAFT_INVALID', 'Der lokale Entwurf hat kein unterstütztes Projektformat.');
    }
    var ids = Object.create(null);
    for (var i = 0; i < project.scenes.length; i++) {
      var scene = project.scenes[i];
      if (!scene || typeof scene.id !== 'string' || !scene.id || ids[scene.id] || !(scene.image instanceof Blob) ||
          !scene.image.size || (scene.hotSpots !== undefined && !Array.isArray(scene.hotSpots))) {
        throw failure('DRAFT_INVALID', 'Im lokalen Entwurf fehlen gültige Panoramen oder Bilddateien.');
      }
      ids[scene.id] = true;
    }
    if (!ids[project.firstScene]) throw failure('DRAFT_INVALID', 'Das Startpanorama fehlt im lokalen Entwurf.');
  }

  // Snapshot metadata immediately, before asynchronous database opening. Blobs
  // are immutable and can be shared until IndexedDB performs its own clone.
  function clone(value, originals, copies) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === undefined) return value;
    if (value instanceof Blob) return value;
    if (typeof value !== 'object') throw failure('DRAFT_INVALID', 'Der Entwurf enthält nicht speicherbare Daten.');
    originals = originals || []; copies = copies || [];
    var index = originals.indexOf(value);
    if (index !== -1) return copies[index];
    var result = Array.isArray(value) ? [] : Object.create(null);
    originals.push(value); copies.push(result);
    for (var key in value) if (own.call(value, key)) result[key] = clone(value[key], originals, copies);
    return result;
  }

  function metadata(record) {
    try {
      if (record) {
        window.localStorage.setItem(METADATA_KEY, JSON.stringify({ version: 1, savedAt: record.savedAt,
          title: record.project.title, sceneCount: record.project.scenes.length }));
      } else window.localStorage.removeItem(METADATA_KEY);
    } catch (_) {
      // IndexedDB is authoritative. A denied or full localStorage must not
      // prevent image persistence, recovery, or clearing a draft.
    }
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      var request, settled = false;
      var timer = window.setTimeout(function () {
        finish(failure('DRAFT_TIMEOUT', 'Das Öffnen des lokalen Entwurfspeichers dauert zu lange.'));
      }, TIMEOUT);
      function finish(error, database) {
        if (settled) { if (database) database.close(); return; }
        settled = true;
        window.clearTimeout(timer);
        if (error) reject(error); else resolve(database);
      }
      try {
        var databaseAPI = window.indexedDB;
        if (!databaseAPI || typeof databaseAPI.open !== 'function') {
          finish(failure('DRAFT_UNAVAILABLE', 'Dieser Browser bietet keinen lokalen Entwurfspeicher an.'));
          return;
        }
        request = databaseAPI.open(DATABASE, 1);
        request.onblocked = function () { finish(failure('DRAFT_BLOCKED', 'Ein anderer Tab blockiert den lokalen Entwurfspeicher.')); };
        request.onerror = function () { finish(failure('DRAFT_UNAVAILABLE', 'Der lokale Entwurfspeicher konnte nicht geöffnet werden.', request.error)); };
        request.onupgradeneeded = function () {
          if (settled) { try { request.transaction.abort(); } catch (_) {} return; }
          try {
            if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
          } catch (error) {
            try { request.transaction.abort(); } catch (_) {}
            finish(failure('DRAFT_STORAGE', 'Der lokale Entwurfspeicher konnte nicht eingerichtet werden.', error));
          }
        };
        request.onsuccess = function () {
          var database = request.result;
          database.onversionchange = function () { database.close(); };
          finish(null, database);
        };
      } catch (error) {
        finish(failure('DRAFT_UNAVAILABLE', 'Der lokale Entwurfspeicher ist in diesem Browser nicht verfügbar.', error));
      }
    });
  }

  function transaction(mode, action) {
    return openDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var tx, settled = false, result, requestError, operationError;
        var timer = window.setTimeout(function () {
          if (tx) try { tx.abort(); } catch (_) {}
          finish(failure('DRAFT_TIMEOUT', 'Der lokale Entwurfspeicher antwortet nicht.'));
        }, TIMEOUT);
        function finish(error) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          database.close();
          if (error) reject(error); else resolve(result);
        }
        try {
          tx = database.transaction(STORE, mode);
          tx.oncomplete = function () { finish(); };
          tx.onabort = function () { finish(operationError || failure('DRAFT_STORAGE', 'Der lokale Entwurf konnte nicht gespeichert oder gelesen werden.', tx.error || requestError)); };
          tx.onerror = function (event) { requestError = (event.target && event.target.error) || tx.error; };
          var request = action(tx.objectStore(STORE), function (value) { result = value; }, function (error) {
            operationError = error;
            try { tx.abort(); } catch (_) { finish(error); }
          });
          if (request) {
            request.onsuccess = function () { result = request.result; };
            request.onerror = function () { requestError = request.error; };
          }
        } catch (error) {
          if (tx) try { tx.abort(); } catch (_) {}
          finish(failure('DRAFT_STORAGE', 'Der lokale Entwurf konnte nicht gespeichert oder gelesen werden.', error));
        }
      });
    });
  }

  function save(project, options) {
    var snapshot, expected, compare = options && own.call(options, 'expectedSavedAt');
    try {
      validate(project); snapshot = clone(project); delete snapshot.savedAt; validate(snapshot);
      if (compare) {
        expected = options.expectedSavedAt;
        if (expected !== null && typeof expected !== 'string') throw failure('DRAFT_INVALID', 'Der Vergleichsstand des lokalen Entwurfs ist ungültig.');
      }
    }
    catch (error) { return Promise.reject(error.code ? error : failure('DRAFT_INVALID', 'Der lokale Entwurf enthält ungültige Daten.', error)); }
    var record;
    return transaction('readwrite', function (store, setResult, abort) {
      // Read and conditional put share one readwrite transaction. Another tab
      // cannot commit between the comparison and this image/metadata write.
      var request = store.get(KEY);
      request.onsuccess = function () {
        try {
          var previous = request.result;
          var previousSavedAt = previous === undefined ? null : previous && previous.savedAt;
          if (compare && expected !== previousSavedAt) {
            abort(failure('DRAFT_CONFLICT', 'Eine neuere Sicherung aus einem anderen Tab ist vorhanden. Dieser Stand wurde nicht überschrieben.'));
            return;
          }
          var previousTime = typeof previousSavedAt === 'string' ? Date.parse(previousSavedAt) : NaN;
          var timestamp = Math.max(Date.now(), isFinite(previousTime) ? previousTime + 1 : 0);
          record = { version: 1, savedAt: new Date(timestamp).toISOString(), project: snapshot };
          var writing = store.put(record, KEY);
          writing.onsuccess = function () { setResult({ savedAt: record.savedAt }); };
        } catch (error) {
          abort(failure('DRAFT_STORAGE', 'Der lokale Entwurf konnte nicht gespeichert werden.', error));
        }
      };
      return null;
    }).then(function (result) {
      metadata(record);
      return result;
    });
  }

  function load() {
    return transaction('readonly', function (store) { return store.get(KEY); }).then(function (record) {
      if (record === undefined) { metadata(null); return null; }
      if (!record || record.version !== 1 || typeof record.savedAt !== 'string' || !isFinite(Date.parse(record.savedAt))) {
        throw failure('DRAFT_INVALID', 'Der gespeicherte lokale Entwurf ist beschädigt.');
      }
      validate(record.project);
      record.project.savedAt = record.savedAt;
      metadata(record);
      return record.project;
    });
  }

  function clear(options) {
    var compare = options && own.call(options, 'expectedSavedAt'), expected;
    try {
      if (compare) {
        expected = options.expectedSavedAt;
        if (expected !== null && typeof expected !== 'string') throw failure('DRAFT_INVALID', 'Der Vergleichsstand des lokalen Entwurfs ist ungültig.');
      }
    } catch (error) { return Promise.reject(error); }
    return transaction('readwrite', function (store, setResult, abort) {
      if (!compare) return store.delete(KEY);
      var request = store.get(KEY);
      request.onsuccess = function () {
        try {
          var previous = request.result;
          var previousSavedAt = previous === undefined ? null : previous && previous.savedAt;
          if (expected !== previousSavedAt) {
            abort(failure('DRAFT_CONFLICT', 'Eine neuere Sicherung aus einem anderen Tab ist vorhanden. Sie wurde nicht gelöscht.'));
            return;
          }
          var deleting = store.delete(KEY);
          deleting.onsuccess = function () { setResult(undefined); };
        } catch (error) { abort(failure('DRAFT_STORAGE', 'Der lokale Entwurf konnte nicht gelöscht werden.', error)); }
      };
      return null;
    }).then(function () { metadata(null); });
  }

  function available() {
    return openDatabase().then(function (database) { database.close(); return true; }, function () { return false; });
  }

  window.tinyPanoDraftStore = { save: save, load: load, clear: clear, available: available };
}());
