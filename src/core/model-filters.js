'use strict';

const { getSettingValueOr } = require('./settings');
const printEvents = require('./print-events');
const { directoryFilterLikePrefix } = require('./folder-tree-lib');

// Additional file types for scan/library (alphabetical by label). id used in settings; extensions for scan/filter.
const ADDITIONAL_FILE_TYPES_CATALOG = [
  { id: '3ds', label: '3DS (.3ds)', extensions: ['.3ds'] },
  { id: 'amf', label: 'AMF (.amf)', extensions: ['.amf'] },
  { id: 'blender', label: 'Blender (.blender)', extensions: ['.blender'] },
  { id: 'chitubox', label: 'ChiTuBox (.chitubox)', extensions: ['.chitubox'] },
  { id: 'dae', label: 'DAE (.dae)', extensions: ['.dae'] },
  { id: 'dxf', label: 'DXF (.dxf)', extensions: ['.dxf'] },
  { id: 'dwg', label: 'DWG (.dwg)', extensions: ['.dwg'] },
  { id: 'fbx', label: 'FBX (.fbx)', extensions: ['.fbx'] },
  { id: 'f3d', label: 'F3D (.f3d)', extensions: ['.f3d'] },
  { id: 'f3z', label: 'F3Z (.f3z)', extensions: ['.f3z'] },
  { id: 'gcode', label: 'G-code (.gcode)', extensions: ['.gcode'] },
  { id: 'igs', label: 'IGES (.igs/.iges)', extensions: ['.igs', '.iges'] },
  { id: 'lys', label: 'LYS/LYT (.lys/.lyt)', extensions: ['.lys', '.lyt'] },
  { id: 'obj', label: 'OBJ (.obj)', extensions: ['.obj'] },
  { id: 'ply', label: 'PLY (.ply)', extensions: ['.ply'] },
  { id: 'step', label: 'STEP (.step/.stp)', extensions: ['.step', '.stp'] },
  { id: 'svg', label: 'SVG (.svg)', extensions: ['.svg'] },
  { id: 'voxl', label: 'VOXL (.voxl)', extensions: ['.voxl'] },
  { id: 'x3d', label: 'X3D (.x3d)', extensions: ['.x3d'] }
];

function getExtensionsForFileTypeFilter(fileTypeValue) {
  if (!fileTypeValue || fileTypeValue === 'zip') return null;
  const lower = fileTypeValue.toLowerCase();
  if (lower === 'stl') return ['.stl'];
  if (lower === '3mf') return ['.3mf'];
  const entry = ADDITIONAL_FILE_TYPES_CATALOG.find(e => e.id === lower || e.extensions.some(ext => ext.slice(1) === lower));
  return entry ? entry.extensions : [`.${lower}`];
}

/** Normalize filter payload: single string or array of strings */
function normalizeFilterValueList(primaryArr, legacyStr) {
  const out = [];
  if (Array.isArray(primaryArr)) {
    for (const x of primaryArr) {
      if (x != null && String(x).trim() !== '') out.push(String(x).trim());
    }
  }
  if (out.length === 0 && legacyStr != null && String(legacyStr).trim() !== '') {
    out.push(String(legacyStr).trim());
  }
  return out;
}

function normalizeTagNameList(filters) {
  if (Array.isArray(filters.tags) && filters.tags.length) {
    return filters.tags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (filters.tag) return [String(filters.tag).trim()].filter(Boolean);
  return [];
}

/** One positive LIKE/EXISTS fragment for a search clause.
 *  filters.searchIncludeNotes false omits notes from field "all" only. Explicit field "notes" always searches notes.
 *  When the flag is absent, the saved searchIncludeNotes setting is used (default on).
 */
function searchIncludeNotesEnabled(filters) {
  if (filters && filters.searchIncludeNotes !== undefined && filters.searchIncludeNotes !== null && filters.searchIncludeNotes !== '') {
    const v = filters.searchIncludeNotes;
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return true;
  }
  return getSettingValueOr('searchIncludeNotes', '1') !== '0';
}

function appendAllFieldsSearchSql(params, term, includeNotes) {
  const notesClause = includeNotes ? "LOWER(COALESCE(notes, '')) LIKE ? OR\n          " : '';
  if (includeNotes) {
    params.push(term, term, term, term, term, term, term, term);
  } else {
    params.push(term, term, term, term, term, term, term);
  }
  return `(
          LOWER(COALESCE(fileName, '')) LIKE ? OR 
          LOWER(COALESCE(designer, '')) LIKE ? OR 
          LOWER(COALESCE(parentModel, '')) LIKE ? OR 
          ${notesClause}LOWER(COALESCE(filePath, '')) LIKE ? OR
          LOWER(COALESCE(source, '')) LIKE ? OR
          LOWER(COALESCE(license, '')) LIKE ? OR
          EXISTS (SELECT 1 FROM model_tags mt INNER JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = models.id AND LOWER(t.name) LIKE ?)
        )`;
}

function pushSearchClauseFragment(field, rawValue, params, filters) {
  const term = `%${String(rawValue).toLowerCase()}%`;
  switch (field) {
    case 'fileName':
      params.push(term);
      return 'LOWER(COALESCE(fileName, \'\')) LIKE ?';
    case 'designer':
      params.push(term);
      return 'LOWER(COALESCE(designer, \'\')) LIKE ?';
    case 'parentModel':
      params.push(term);
      return 'LOWER(COALESCE(parentModel, \'\')) LIKE ?';
    case 'notes':
      params.push(term);
      return 'LOWER(COALESCE(notes, \'\')) LIKE ?';
    case 'filePath':
      params.push(term);
      return 'LOWER(COALESCE(filePath, \'\')) LIKE ?';
    case 'source':
      params.push(term);
      return 'LOWER(COALESCE(source, \'\')) LIKE ?';
    case 'license':
      params.push(term);
      return 'LOWER(COALESCE(license, \'\')) LIKE ?';
    case 'tag':
      params.push(term);
      return 'EXISTS (SELECT 1 FROM model_tags mt INNER JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = models.id AND LOWER(t.name) LIKE ?)';
    default:
      return appendAllFieldsSearchSql(params, term, searchIncludeNotesEnabled(filters));
  }
}

function sanitizeSearchTokensForCompile(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    if (x.t === 'clause') {
      const val = String(x.value || '').trim();
      if (!val) continue;
      const field = String(x.field || 'all').trim() || 'all';
      out.push({ t: 'clause', field, value: val });
    } else if (x.t === 'op' && (x.op === 'AND' || x.op === 'OR')) {
      out.push({ t: 'op', op: x.op });
    } else if (x.t === 'not') {
      out.push({ t: 'not' });
    } else if (x.t === 'filter') {
      const kind = String(x.kind || '').trim();
      if (!kind || !['designer', 'license', 'parentModel', 'tag', 'fileType', 'printed', 'isNew', 'favorite', 'rating', 'ratingMin'].includes(kind)) continue;
      const valRaw = String(x.value != null ? x.value : '').trim();
      if (kind === 'printed') {
        const allowed = ['printed', 'not-printed', 'unprinted', 'want', 'queued', 'printing', 'failed', 'ever-printed', 'never-printed', 'in-queue'];
        if (!allowed.includes(valRaw)) continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (kind === 'isNew') {
        if (valRaw !== 'new' && valRaw !== 'not-new') continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (kind === 'favorite') {
        if (valRaw !== 'favorited' && valRaw !== 'not-favorited') continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (kind === 'rating') {
        if (valRaw !== 'unrated' && !/^[1-5]$/.test(valRaw)) continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (kind === 'ratingMin') {
        if (!/^[1-5]$/.test(valRaw)) continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (!valRaw) {
        continue;
      } else {
        const ftNorm = kind === 'fileType' && valRaw.toLowerCase() === 'zip' ? 'zip' : valRaw;
        out.push({ t: 'filter', kind, value: ftNorm });
      }
    } else if (x.t === 'filterMulti') {
      const kind = String(x.kind || '').trim();
      if (!kind || !['designer', 'license', 'parentModel', 'tag'].includes(kind)) continue;
      const vals = Array.isArray(x.values) ? x.values.map((v) => String(v).trim()).filter(Boolean) : [];
      if (vals.length === 0) continue;
      const combine = String(x.combine || 'OR').toUpperCase() === 'AND' ? 'AND' : 'OR';
      out.push({ t: 'filterMulti', kind, values: vals, combine });
    }
  }
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    if (a.t === 'op' && b.t === 'op' && a.op === b.op) {
      out.splice(i, 1);
      i--;
    }
  }
  while (out.length && (out[out.length - 1].t === 'op' || out[out.length - 1].t === 'not')) {
    out.pop();
  }
  return out;
}

/** SQL fragment for a sidebar filter serialized into searchTokens ({ t: filter | filterMulti }). */
function compileSidebarFilterClauseToSQL(tok, filters, params) {
  if (tok.t === 'filterMulti') {
    const combine = tok.combine === 'AND' ? 'AND' : 'OR';
    if (tok.kind === 'designer') {
      const cond = [];
      pushEqualityListCondition(cond, params, 'designer', tok.values.slice(), combine, !!filters.designerInverted, true);
      return cond[0] || '1';
    }
    if (tok.kind === 'license') {
      const cond = [];
      pushEqualityListCondition(cond, params, 'license', tok.values.slice(), combine, !!filters.licenseInverted, false);
      return cond[0] || '1';
    }
    if (tok.kind === 'parentModel') {
      const cond = [];
      pushEqualityListCondition(cond, params, 'parentModel', tok.values.slice(), combine, !!filters.parentModelInverted, false);
      return cond[0] || '1';
    }
    if (tok.kind === 'tag') {
      const names = tok.values.slice();
      const f = {
        tags: names,
        tagCombine: combine,
        tagInverted: !!filters.tagInverted,
      };
      const cond = [];
      pushTagListSQL(cond, params, f);
      return cond[0] || '1';
    }
    return null;
  }
  if (tok.t !== 'filter') return null;
  if (tok.kind === 'designer' || tok.kind === 'license' || tok.kind === 'parentModel') {
    const cond = [];
    const col = tok.kind === 'designer' ? 'designer' : tok.kind === 'license' ? 'license' : 'parentModel';
    const inverted = !!(tok.kind === 'designer' ? filters.designerInverted : tok.kind === 'license' ? filters.licenseInverted : filters.parentModelInverted);
    const useLowerTrim = tok.kind === 'designer';
    pushEqualityListCondition(cond, params, col, [tok.value], 'OR', inverted, useLowerTrim);
    return cond[0] || '1';
  }
  if (tok.kind === 'tag') {
    const f = { tags: [tok.value], tagCombine: 'OR', tagInverted: !!filters.tagInverted };
    const cond = [];
    pushTagListSQL(cond, params, f);
    return cond[0] || '1';
  }
  if (tok.kind === 'fileType') {
    const ftVal = tok.value;
    if (!ftVal) return null;
    if (ftVal.toLowerCase() === 'zip') {
      params.push('%::%');
      return '(filePath LIKE ?)';
    }
    const exts = getExtensionsForFileTypeFilter(ftVal);
    if (!exts || exts.length === 0) {
      params.push(`%.${String(ftVal).toLowerCase()}`);
      return '(LOWER(fileName) LIKE ?)';
    }
    if (exts.length === 1) {
      params.push(`%${exts[0]}`);
      return '(LOWER(fileName) LIKE ?)';
    }
    const ph = exts.map(() => 'LOWER(fileName) LIKE ?').join(' OR ');
    params.push(...exts.map(ext => `%${ext}`));
    return `(${ph})`;
  }
  if (tok.kind === 'printed') {
    const bound = printEvents.printFilterSqlBound(tok.value);
    if (!bound) return null;
    if (bound.params.length) params.push(...bound.params);
    return bound.sql;
  }
  if (tok.kind === 'isNew') {
    if (tok.value === 'new') return '(isNew = 1)';
    if (tok.value === 'not-new') return '(isNew = 0 OR isNew IS NULL)';
    return null;
  }
  if (tok.kind === 'favorite') {
    if (tok.value === 'favorited') return '(favorite = 1)';
    if (tok.value === 'not-favorited') return '(favorite = 0 OR favorite IS NULL)';
    return null;
  }
  if (tok.kind === 'rating') {
    if (tok.value === 'unrated') return '(rating = 0 OR rating IS NULL)';
    if (/^[1-5]$/.test(tok.value)) {
      params.push(parseInt(tok.value, 10));
      return '(rating = ?)';
    }
    return null;
  }
  if (tok.kind === 'ratingMin') {
    if (/^[1-5]$/.test(tok.value)) {
      params.push(parseInt(tok.value, 10));
      return '(rating >= ?)';
    }
    return null;
  }
  return null;
}

function parseSearchPrimary(tokens, i, params, filters) {
  if (i >= tokens.length) {
    throw new Error('search expression incomplete');
  }
  const tok = tokens[i];
  if (tok.t === 'clause') {
    const frag = pushSearchClauseFragment(tok.field || 'all', tok.value, params, filters);
    return [`(${frag})`, i + 1];
  }
  if (tok.t === 'filter' || tok.t === 'filterMulti') {
    const inner = compileSidebarFilterClauseToSQL(tok, filters, params);
    if (!inner) throw new Error('search expression invalid filter');
    return [`(${inner})`, i + 1];
  }
  throw new Error('search expression expected term');
}

function parseSearchUnary(tokens, i, params, filters) {
  let negate = false;
  let j = i;
  while (j < tokens.length && tokens[j].t === 'not') {
    negate = !negate;
    j++;
  }
  const [inner, k] = parseSearchPrimary(tokens, j, params, filters);
  if (negate) {
    // COALESCE: a NULL column makes the comparison NULL, and NOT NULL would drop the row.
    return [`NOT COALESCE((${inner}), 0)`, k];
  }
  return [inner, k];
}

function parseSearchAnd(tokens, i, params, filters) {
  let [left, j] = parseSearchUnary(tokens, i, params, filters);
  while (j < tokens.length && tokens[j].t === 'op' && tokens[j].op === 'AND') {
    j++;
    const [right, k] = parseSearchUnary(tokens, j, params, filters);
    left = `(${left}) AND (${right})`;
    j = k;
  }
  return [left, j];
}

function parseSearchOr(tokens, i, params, filters) {
  let [left, j] = parseSearchAnd(tokens, i, params, filters);
  while (j < tokens.length && tokens[j].t === 'op' && tokens[j].op === 'OR') {
    j++;
    const [right, k] = parseSearchAnd(tokens, j, params, filters);
    left = `(${left}) OR (${right})`;
    j = k;
  }
  return [left, j];
}

function compileSearchTokensToSQL(tokens, params, filters) {
  const t = sanitizeSearchTokensForCompile(tokens);
  if (t.length === 0) return null;
  try {
    const [sql, end] = parseSearchOr(t, 0, params, filters);
    if (end !== t.length) return null;
    return sql;
  } catch (e) {
    console.warn('compileSearchTokensToSQL failed:', e.message);
    return null;
  }
}

/** Multi-value designer / parentModel / license (matches legacy single-value SQL for invert + NULL). */
function pushEqualityListCondition(conditions, params, column, values, combineOp, inverted, useLowerTrim) {
  if (!values.length) return;
  const posJoin = combineOp === 'AND' ? ' AND ' : ' OR ';
  if (!inverted) {
    const posParts = [];
    for (const v of values) {
      if (v === '__none__') {
        posParts.push(`(${column} IS NULL OR ${column} = '')`);
      } else if (useLowerTrim) {
        params.push(v);
        posParts.push(`LOWER(TRIM(${column})) = LOWER(TRIM(?))`);
      } else {
        params.push(v);
        posParts.push(`${column} = ?`);
      }
    }
    conditions.push(posParts.length === 1 ? posParts[0] : `(${posParts.join(posJoin)})`);
    return;
  }
  const negJoin = combineOp === 'OR' ? ' AND ' : ' OR ';
  const negParts = [];
  for (const v of values) {
    if (v === '__none__') {
      negParts.push(`(${column} IS NOT NULL AND ${column} != '')`);
    } else if (useLowerTrim) {
      params.push(v);
      negParts.push(`(${column} IS NULL OR ${column} = '' OR LOWER(TRIM(${column})) != LOWER(TRIM(?)))`);
    } else {
      params.push(v);
      negParts.push(`(${column} IS NULL OR ${column} = '' OR ${column} != ?)`);
    }
  }
  conditions.push(negParts.length === 1 ? negParts[0] : `(${negParts.join(negJoin)})`);
}

function pushTagListSQL(conditions, params, filters) {
  const tagNames = normalizeTagNameList(filters);
  if (!tagNames.length) return false;
  const combine = filters.tagCombine === 'AND' ? 'AND' : 'OR';
  const inverted = !!filters.tagInverted;
  let inner;
  if (combine === 'OR') {
    const ph = tagNames.map(() => '?').join(', ');
    inner = `EXISTS (SELECT 1 FROM model_tags mt INNER JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = models.id AND t.name IN (${ph}))`;
    params.push(...tagNames);
  } else {
    const existsParts = [];
    for (const tn of tagNames) {
      params.push(tn);
      existsParts.push(
        'EXISTS (SELECT 1 FROM model_tags mt INNER JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = models.id AND t.name = ?)'
      );
    }
    inner = `(${existsParts.join(' AND ')})`;
  }
  if (inverted) {
    conditions.push(`NOT (${inner})`);
  } else {
    conditions.push(inner);
  }
  return true;
}

function buildModelFilterConditions(filters) {
  const conditions = [];
  const params = [];
  if (!filters || typeof filters !== 'object') {
    return { conditions, params };
  }

  // Designer filter (multi-value + legacy single)
    const designers = normalizeFilterValueList(filters.designers, filters.designer);
    if (designers.length) {
      pushEqualityListCondition(
        conditions,
        params,
        'designer',
        designers,
        filters.designerCombine === 'AND' ? 'AND' : 'OR',
        !!filters.designerInverted,
        true
      );
    }

    // License filter
    const licenses = normalizeFilterValueList(filters.licenses, filters.license);
    if (licenses.length) {
      pushEqualityListCondition(
        conditions,
        params,
        'license',
        licenses,
        filters.licenseCombine === 'AND' ? 'AND' : 'OR',
        !!filters.licenseInverted,
        false
      );
    }

    // Parent model filter
    const parentModels = normalizeFilterValueList(filters.parentModels, filters.parentModel);
    if (parentModels.length) {
      pushEqualityListCondition(
        conditions,
        params,
        'parentModel',
        parentModels,
        filters.parentModelCombine === 'AND' ? 'AND' : 'OR',
        !!filters.parentModelInverted,
        false
      );
    }
    
    // Print status / history filter
    if (filters.printed !== undefined && filters.printed !== 'all') {
      const bound = printEvents.printFilterSqlBound(filters.printed);
      if (bound) {
        conditions.push(bound.sql);
        if (bound.params.length) params.push(...bound.params);
      }
    }

    const normalizedIsNew =
      typeof filters.isNew === 'string' ? filters.isNew.trim().toLowerCase() : filters.isNew;
    if (
      normalizedIsNew !== undefined &&
      normalizedIsNew !== null &&
      normalizedIsNew !== '' &&
      normalizedIsNew !== 'all' &&
      normalizedIsNew !== 'undefined' &&
      normalizedIsNew !== 'null'
    ) {
      if (normalizedIsNew === 'new') {
        conditions.push("isNew = 1");
      } else if (normalizedIsNew === 'not-new') {
        conditions.push("(isNew = 0 OR isNew IS NULL)");
      }
    }

    const normalizedFavorite =
      typeof filters.favorite === 'string' ? filters.favorite.trim().toLowerCase() : filters.favorite;
    if (
      normalizedFavorite !== undefined &&
      normalizedFavorite !== null &&
      normalizedFavorite !== '' &&
      normalizedFavorite !== 'all' &&
      normalizedFavorite !== 'undefined' &&
      normalizedFavorite !== 'null'
    ) {
      if (normalizedFavorite === 'favorited') {
        conditions.push("favorite = 1");
      } else if (normalizedFavorite === 'not-favorited') {
        conditions.push("(favorite = 0 OR favorite IS NULL)");
      }
    }

    const normalizedRating =
      typeof filters.rating === 'string' ? filters.rating.trim().toLowerCase() : filters.rating;
    if (
      normalizedRating !== undefined &&
      normalizedRating !== null &&
      normalizedRating !== '' &&
      normalizedRating !== 'all' &&
      normalizedRating !== 'undefined' &&
      normalizedRating !== 'null'
    ) {
      if (normalizedRating === 'unrated') {
        conditions.push("(rating = 0 OR rating IS NULL)");
      } else if (/^[1-5]$/.test(String(normalizedRating))) {
        conditions.push("rating = ?");
        params.push(parseInt(normalizedRating, 10));
      }
    }

    const normalizedRatingMin =
      typeof filters.ratingMin === 'string' ? filters.ratingMin.trim().toLowerCase() : filters.ratingMin;
    if (
      normalizedRatingMin !== undefined &&
      normalizedRatingMin !== null &&
      normalizedRatingMin !== '' &&
      normalizedRatingMin !== 'all' &&
      normalizedRatingMin !== 'undefined' &&
      normalizedRatingMin !== 'null' &&
      /^[1-5]$/.test(String(normalizedRatingMin))
    ) {
      conditions.push("rating >= ?");
      params.push(parseInt(normalizedRatingMin, 10));
    }
    
    // File type filter
    if (filters.fileType) {
      if (filters.fileType.toLowerCase() === 'zip') {
        // For zip filter, show all models inside ZIP archives (entries with :: separator)
        conditions.push("filePath LIKE ?");
        params.push('%::%');
      } else {
        const exts = getExtensionsForFileTypeFilter(filters.fileType);
        if (exts.length === 1) {
          conditions.push("LOWER(fileName) LIKE ?");
          params.push(`%${exts[0]}`);
        } else {
          conditions.push("(" + exts.map(() => "LOWER(fileName) LIKE ?").join(" OR ") + ")");
          params.push(...exts.map(ext => `%${ext}`));
        }
      }
    }
    
    // Directory filter. Stored zip entries mix separators (`C:\lib\pack.zip::folder/part.stl`),
    // so compare a slash-normalized path instead of two LIKE patterns that each miss half the path.
    if (filters.directory) {
      const directoryPrefix = directoryFilterLikePrefix(filters.directory);
      if (directoryPrefix) {
        conditions.push("REPLACE(LOWER(filePath), CHAR(92), '/') LIKE ?");
        params.push(directoryPrefix);
      }
    }
    
    // Search: token expression (AND/OR/NOT), legacy clauses, or single string
    if (Array.isArray(filters.searchTokens) && filters.searchTokens.length) {
      const combined = compileSearchTokensToSQL(filters.searchTokens, params, filters);
      if (combined) {
        if (filters.searchInverted) {
          conditions.push(`NOT COALESCE((${combined}), 0)`);
        } else {
          conditions.push(`(${combined})`);
        }
      }
    } else if (Array.isArray(filters.searchClauses) && filters.searchClauses.length) {
      const op = filters.searchClauseOp === 'OR' ? ' OR ' : ' AND ';
      const parts = [];
      for (const c of filters.searchClauses) {
        const val = c && String(c.value || '').trim();
        if (!val) continue;
        const frag = pushSearchClauseFragment(c.field || 'all', val, params, filters);
        parts.push(`(${frag})`);
      }
      if (parts.length) {
        const combined = parts.join(op);
        if (filters.searchInverted) {
          conditions.push(`NOT COALESCE((${combined}), 0)`);
        } else {
          conditions.push(`(${combined})`);
        }
      }
    } else if (filters.search) {
      const frag = pushSearchClauseFragment('all', filters.search, params, filters);
      if (filters.searchInverted) {
        conditions.push(`NOT COALESCE((${frag}), 0)`);
      } else {
        conditions.push(frag);
      }
    }

    pushTagListSQL(conditions, params, filters);

    // Date Added filter (filter by dateAdded >= specified date)
    if (filters.dateAdded) {
      conditions.push("dateAdded >= ?");
      params.push(filters.dateAdded);
    }

  return { conditions, params };
}

function sqlAndFilterConditions(conditions) {
  if (!conditions.length) return '';
  return ` AND ${conditions.join(' AND ')}`;
}

module.exports = { ADDITIONAL_FILE_TYPES_CATALOG, buildModelFilterConditions, sqlAndFilterConditions };
