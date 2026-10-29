const characterData = require('./data/character-components/index.json');

const BOARD_SIZE = 5;
const unknownMarkers = new Set(['？', '?']);
const characterRecords = new Map(characterData.characters.map(record => [record.character, record]));
const sequenceMemo = new Map();

function getOpOrientations(operator) {
  switch (operator) {
    case '\u2FF0': // ⿰ left-right
    case '\u2FF2': // ⿲ left-middle-right
    case '\u2FF7': // 匚 enclosure-from-left
    case '\u2FFA': // ⿺ enclosure-from-lower-left
      return new Set(['horizontal']);

    case '\u2FF1': // ⿱ above-below
    case '\u2FF3': // ⿳ above-middle-below
    case '\u2FF5': // ⿵ enclosure-from-above
    case '\u2FF6': // ⿶ enclosure-from-below
      return new Set(['vertical']);

    case '\u2FF8': // ⿸ enclosure-from-upper-left
    case '\u2FF9': // ⿹ enclosure-from-upper-right
    case '\u2FF4': // ⿴ full-enclosure
    case '\u2FFB': // ⿻ overlay
    default:
      return new Set(['horizontal', 'vertical']);
  }
}

function combineChildSets(childSequenceSets, opOrientations) {
  let combined = [{ sequence: [], orientations: new Set(['horizontal', 'vertical']) }];

  for (const childSequences of childSequenceSets) {
    const nextMap = new Map();
    for (const prefix of combined) {
      for (const suffix of childSequences) {
        if (prefix.sequence.length + suffix.sequence.length > BOARD_SIZE) continue;

        const validOrientations = new Set();
        for (const orientation of ['horizontal', 'vertical']) {
          const transitionOk = prefix.sequence.length === 0 || opOrientations.has(orientation);
          const prefixOk = prefix.orientations.has(orientation);
          const suffixOk = suffix.orientations.has(orientation);

          if (transitionOk && prefixOk && suffixOk) {
            validOrientations.add(orientation);
          }
        }

        if (validOrientations.size === 0) continue;

        const sequence = [...prefix.sequence, ...suffix.sequence];
        const key = sequence.join('');

        if (nextMap.has(key)) {
          const existing = nextMap.get(key);
          validOrientations.forEach(o => existing.orientations.add(o));
        } else {
          nextMap.set(key, { sequence, orientations: validOrientations });
        }
      }
    }
    combined = [...nextMap.values()];
    if (combined.length === 0) break;
  }

  return combined;
}

function sequencesForNode(node, ancestors) {
  if (node.character !== undefined) {
    if (unknownMarkers.has(node.character)) return [];

    const sequencesMap = new Map();
    sequencesMap.set(node.character, {
      sequence: [node.character],
      orientations: new Set(['horizontal', 'vertical'])
    });

    for (const item of sequencesForCharacter(node.character, ancestors)) {
      const key = item.sequence.join('');
      if (sequencesMap.has(key)) {
        const existing = sequencesMap.get(key);
        item.orientations.forEach(o => existing.orientations.add(o));
      } else {
        sequencesMap.set(key, {
          sequence: item.sequence,
          orientations: new Set(item.orientations)
        });
      }
    }
    return [...sequencesMap.values()];
  }

  const opOrientations = getOpOrientations(node.operator);
  const childSequenceSets = node.components.map(child => sequencesForNode(child, ancestors));
  return combineChildSets(childSequenceSets, opOrientations);
}

function sequencesForCharacter(character, ancestors = new Set()) {
  if (ancestors.has(character)) return [];
  if (sequenceMemo.has(character)) return sequenceMemo.get(character);

  const record = characterRecords.get(character);
  if (!record || !record.complete || !record.tree) return [];

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(character);
  const sequences = sequencesForNode(record.tree, nextAncestors);
  sequenceMemo.set(character, sequences);
  return sequences;
}

const validSequences = {
  horizontal: new Map(),
  vertical: new Map()
};

function buildSequenceTargets() {
  for (const record of characterData.characters) {
    if (!record.complete) continue;
    for (const item of sequencesForCharacter(record.character)) {
      if (item.sequence.length < 2 || item.sequence.length > BOARD_SIZE) continue;
      const key = item.sequence.join('');
      for (const orientation of item.orientations) {
        const targetsMap = validSequences[orientation];
        if (!targetsMap.has(key)) targetsMap.set(key, new Set());
        targetsMap.get(key).add(record.character);
      }
    }
  }
  return validSequences;
}

buildSequenceTargets();

function scanLine(board, positions, orientation, matches) {
  const targetsMap = validSequences[orientation];
  if (!targetsMap) return;
  for (let start = 0; start < positions.length; start++) {
    let sequence = '';
    for (let end = start; end < positions.length; end++) {
      const tile = board[positions[end]];
      if (typeof tile !== 'string' || Array.from(tile).length !== 1) break;
      sequence += tile;
      if (end === start) continue;

      const targets = targetsMap.get(sequence);
      if (!targets) continue;
      const matchedPositions = positions.slice(start, end + 1);
      for (const character of targets) {
        const key = `${character}:${matchedPositions.join(',')}`;
        if (!matches.has(key)) {
          matches.set(key, {
            character,
            word: character,
            score: matchedPositions.length,
            positions: matchedPositions,
            tileCount: matchedPositions.length,
            orientation,
            sequence
          });
        }
      }
    }
  }
}

function scoreBoard(board) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE * BOARD_SIZE) {
    throw new TypeError(`Expected a ${BOARD_SIZE}x${BOARD_SIZE} row-major board.`);
  }

  const matches = new Map();
  for (let row = 0; row < BOARD_SIZE; row++) {
    scanLine(board, Array.from({ length: BOARD_SIZE }, (_, column) => row * BOARD_SIZE + column), 'horizontal', matches);
  }
  for (let column = 0; column < BOARD_SIZE; column++) {
    scanLine(board, Array.from({ length: BOARD_SIZE }, (_, row) => row * BOARD_SIZE + column), 'vertical', matches);
  }

  const words = [...matches.values()].sort((left, right) =>
    left.tileCount - right.tileCount
    || left.positions[0] - right.positions[0]
    || left.character.localeCompare(right.character)
  );
  return {
    words,
    total: words.reduce((sum, word) => sum + word.tileCount, 0)
  };
}

function getDecompositions(char, maxLen = BOARD_SIZE) {
  const rec = characterRecords.get(char);
  if (!rec || !rec.complete || !rec.tree) return [];

  function expandNode(node) {
    if (node.character) {
      const c = node.character;
      const res = [[c]];
      const subRec = characterRecords.get(node.character);
      if (subRec && subRec.complete && subRec.tree && subRec.tree.operator) {
        for (const sub of expandNode(subRec.tree)) res.push(sub);
      }
      return res;
    }
    if (node.operator && node.components) {
      let combined = [[]];
      for (const comp of node.components) {
        const compExpansions = expandNode(comp);
        const next = [];
        for (const prefix of combined) {
          for (const suffix of compExpansions) {
            if (prefix.length + suffix.length <= maxLen) next.push([...prefix, ...suffix]);
          }
        }
        combined = next;
      }
      return combined;
    }
    return [];
  }
  return expandNode(rec.tree).filter(seq => seq.length >= 2 && seq.length <= maxLen);
}

const multisetIndex = new Map();
function buildMultisetIndex() {
  for (const rec of characterData.characters) {
    if (!rec.complete) continue;
    for (const seq of getDecompositions(rec.character)) {
      const key = [...seq].sort().join('');
      if (!multisetIndex.has(key)) multisetIndex.set(key, new Set());
      multisetIndex.get(key).add(rec.character);
    }
  }
}
buildMultisetIndex();

function checkSpatialRelation(op, p1, p2) {
  const minR1 = Math.min(...p1.map(t => t.r)), maxR1 = Math.max(...p1.map(t => t.r));
  const minC1 = Math.min(...p1.map(t => t.c)), maxC1 = Math.max(...p1.map(t => t.c));
  const minR2 = Math.min(...p2.map(t => t.r)), maxR2 = Math.max(...p2.map(t => t.r));
  const minC2 = Math.min(...p2.map(t => t.c)), maxC2 = Math.max(...p2.map(t => t.c));

  switch (op) {
    case '⿰': // Left-Right: p1 is left of p2
      return maxC1 <= minC2 && (minC1 < maxC2 || minC2 > maxC1) && !(maxR1 < minR2 || minR1 > maxR2);
    case '⿱': // Above-Below: p1 is above p2
      return maxR1 <= minR2 && (minR1 < maxR2 || minR2 > maxR1) && !(maxC1 < minC2 || minC1 > maxC2);
    case '⿸': // Enclosure from upper-left
      return minR1 <= minR2 && minC1 <= minC2;
    case '⿺': // Enclosure from lower-left
      return maxR1 >= maxR2 && minC1 <= minC2;
    case '⿹': // Enclosure from upper-right
      return minR1 <= minR2 && maxC1 >= maxC2;
    case '⿵': // Enclosure from above
      return minR1 <= minR2;
    case '⿶': // Enclosure from below
      return maxR1 >= maxR2;
    case '⿷': // Enclosure from left
      return minC1 <= minC2;
    default:
      return true;
  }
}

function checkSpatialRelation3(op, p1, p2, p3) {
  const minC1 = Math.min(...p1.map(t => t.c)), maxC1 = Math.max(...p1.map(t => t.c));
  const minC2 = Math.min(...p2.map(t => t.c)), maxC2 = Math.max(...p2.map(t => t.c));
  const minC3 = Math.min(...p3.map(t => t.c)), maxC3 = Math.max(...p3.map(t => t.c));
  const minR1 = Math.min(...p1.map(t => t.r)), maxR1 = Math.max(...p1.map(t => t.r));
  const minR2 = Math.min(...p2.map(t => t.r)), maxR2 = Math.max(...p2.map(t => t.r));
  const minR3 = Math.min(...p3.map(t => t.r)), maxR3 = Math.max(...p3.map(t => t.r));

  if (op === '⿲') return maxC1 <= minC2 && maxC2 <= minC3;
  if (op === '⿳') return maxR1 <= minR2 && maxR2 <= minR3;
  return true;
}

function matchNode(node, tiles) {
  if (tiles.length === 1) {
    const tileChar = tiles[0].char;
    if (node.character) {
      if (node.character === tileChar) return true;
      const rec = characterRecords.get(node.character);
      if (rec && rec.complete && rec.tree && rec.tree.character) {
        return rec.tree.character === tileChar;
      }
    }
    return false;
  }

  if (node.character) {
    const rec = characterRecords.get(node.character);
    if (rec && rec.complete && rec.tree) return matchNode(rec.tree, tiles);
    return false;
  }

  const op = node.operator;
  const comps = node.components;
  if (!op || !comps) return false;

  const n = tiles.length;
  if (comps.length === 2) {
    const [c1, c2] = comps;
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      const p1 = [], p2 = [];
      for (let i = 0; i < n; i++) {
        if ((mask >> i) & 1) p1.push(tiles[i]);
        else p2.push(tiles[i]);
      }
      if (checkSpatialRelation(op, p1, p2)) {
        if (matchNode(c1, p1) && matchNode(c2, p2)) return true;
      }
    }
    return false;
  }

  if (comps.length === 3) {
    const [c1, c2, c3] = comps;
    for (let m1 = 1; m1 < (1 << n); m1++) {
      for (let m2 = 1; m2 < (1 << n); m2++) {
        if ((m1 & m2) !== 0) continue;
        const m3 = ((1 << n) - 1) ^ (m1 | m2);
        if (m3 === 0) continue;
        const p1 = [], p2 = [], p3 = [];
        for (let i = 0; i < n; i++) {
          if ((m1 >> i) & 1) p1.push(tiles[i]);
          else if ((m2 >> i) & 1) p2.push(tiles[i]);
          else p3.push(tiles[i]);
        }
        if (checkSpatialRelation3(op, p1, p2, p3)) {
          if (matchNode(c1, p1) && matchNode(c2, p2) && matchNode(c3, p3)) return true;
        }
      }
    }
    return false;
  }
  return false;
}

function findCharactersForTiles(tiles) {
  const key = tiles.map(t => t.char).sort().join('');
  const candidates = multisetIndex.get(key);
  if (!candidates) return [];
  const matched = [];
  for (const char of candidates) {
    const rec = characterRecords.get(char);
    if (rec && rec.complete && rec.tree && matchNode(rec.tree, tiles)) {
      matched.push(char);
    }
  }
  return matched;
}

function arePositionsConnected(positions) {
  if (positions.length <= 1) return true;
  const posSet = new Set(positions);
  const visited = new Set();
  const queue = [positions[0]];
  visited.add(positions[0]);
  while (queue.length > 0) {
    const curr = queue.shift();
    const r = Math.floor(curr / BOARD_SIZE);
    const c = curr % BOARD_SIZE;
    const neighbors = [];
    if (r > 0) neighbors.push((r - 1) * BOARD_SIZE + c);
    if (r < BOARD_SIZE - 1) neighbors.push((r + 1) * BOARD_SIZE + c);
    if (c > 0) neighbors.push(r * BOARD_SIZE + (c - 1));
    if (c < BOARD_SIZE - 1) neighbors.push(r * BOARD_SIZE + (c + 1));
    for (const n of neighbors) {
      if (posSet.has(n) && !visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  return visited.size === positions.length;
}

function getClaimPositions(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24) return null;
  const startRow = Math.floor(start / BOARD_SIZE);
  const endRow = Math.floor(end / BOARD_SIZE);
  const startColumn = start % BOARD_SIZE;
  const endColumn = end % BOARD_SIZE;
  const positions = [];
  let orientation = null;

  if (startRow === endRow && endColumn >= startColumn) {
    orientation = 'horizontal';
    for (let column = startColumn; column <= endColumn; column++) positions.push(startRow * BOARD_SIZE + column);
  } else if (startColumn === endColumn && endRow >= startRow) {
    orientation = 'vertical';
    for (let row = startRow; row <= endRow; row++) positions.push(row * BOARD_SIZE + startColumn);
  } else {
    return null;
  }

  return positions.length >= 2 && positions.length <= BOARD_SIZE ? { positions, orientation } : null;
}

function validateWordClaim(board, startOrPositions, maybeEnd) {
  let positions = null;

  if (Array.isArray(startOrPositions)) {
    positions = startOrPositions;
  } else if (typeof startOrPositions === 'object' && startOrPositions !== null) {
    if (Array.isArray(startOrPositions.positions)) {
      positions = startOrPositions.positions;
    } else if (Number.isInteger(startOrPositions.start) && Number.isInteger(startOrPositions.end)) {
      const info = getClaimPositions(startOrPositions.start, startOrPositions.end);
      if (!info) return { valid: false, error: '请选择同一行或同一列的 2 至 5 个连续字块。' };
      positions = info.positions;
    }
  } else if (Number.isInteger(startOrPositions) && Number.isInteger(maybeEnd)) {
    const info = getClaimPositions(startOrPositions, maybeEnd);
    if (!info) return { valid: false, error: '请选择同一行或同一列的 2 至 5 个连续字块。' };
    positions = info.positions;
  }

  if (!positions || !Array.isArray(positions)) {
    return { valid: false, error: '请选择有效字块。' };
  }

  if (positions.length < 2 || positions.length > BOARD_SIZE) {
    return { valid: false, error: '请选择 2 至 5 个相邻字块。' };
  }

  if (new Set(positions).size !== positions.length) {
    return { valid: false, error: '字块不能重复选择。' };
  }

  if (positions.some(pos => !Number.isInteger(pos) || pos < 0 || pos >= BOARD_SIZE * BOARD_SIZE)) {
    return { valid: false, error: '所选字块超出棋盘范围。' };
  }

  const grid = Array.isArray(board) ? board : [];
  if (positions.some(pos => !grid[pos])) {
    return { valid: false, error: '所选区域包含空格。' };
  }

  if (!arePositionsConnected(positions)) {
    return { valid: false, error: '所选字块必须相互相邻。' };
  }

  // Determine orientation
  const rows = positions.map(pos => Math.floor(pos / BOARD_SIZE));
  const cols = positions.map(pos => pos % BOARD_SIZE);
  const minRow = Math.min(...rows), maxRow = Math.max(...rows);
  const minCol = Math.min(...cols), maxCol = Math.max(...cols);

  let orientation = 'adjacent';
  if (minRow === maxRow && maxCol - minCol + 1 === positions.length) {
    orientation = 'horizontal';
  } else if (minCol === maxCol && maxRow - minRow + 1 === positions.length) {
    orientation = 'vertical';
  }

  const tiles = positions.map(pos => ({
    r: Math.floor(pos / BOARD_SIZE),
    c: pos % BOARD_SIZE,
    char: grid[pos]
  }));

  const matchedSet = new Set();

  // 1) 2D structural match based on character decomposition
  for (const char of findCharactersForTiles(tiles)) {
    matchedSet.add(char);
  }

  // 2) 1D sequence match (horizontal or vertical)
  if (orientation === 'horizontal') {
    const seq = positions.slice().sort((a, b) => (a % BOARD_SIZE) - (b % BOARD_SIZE)).map(p => grid[p]).join('');
    const targets = validSequences.horizontal.get(seq);
    if (targets) for (const c of targets) matchedSet.add(c);
  } else if (orientation === 'vertical') {
    const seq = positions.slice().sort((a, b) => Math.floor(a / BOARD_SIZE) - Math.floor(b / BOARD_SIZE)).map(p => grid[p]).join('');
    const targets = validSequences.vertical.get(seq);
    if (targets) for (const c of targets) matchedSet.add(c);
  }

  const sequence = positions.map(pos => grid[pos]).join('');
  if (matchedSet.size === 0) {
    const dirText = orientation === 'horizontal' ? '横向' : orientation === 'vertical' ? '纵向' : '所选布局';
    return { valid: false, error: `「${sequence}」在${dirText}上无法合成有效汉字。` };
  }

  return {
    valid: true,
    sequence,
    characters: [...matchedSet],
    positions: positions.slice().sort((a, b) => a - b),
    tileCount: positions.length,
    orientation
  };
}

module.exports = { scoreBoard, validSequences, getClaimPositions, validateWordClaim };