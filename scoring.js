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

function getNodeTree(node) {
  if (node.operator) return node;
  if (node.character) {
    const rec = characterRecords.get(node.character);
    if (rec && rec.complete && rec.tree && rec.tree.operator) {
      return rec.tree;
    }
  }
  return null;
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
  const combined = combineChildSets(childSequenceSets, opOrientations);

  const sequencesMap = new Map();
  for (const item of combined) {
    sequencesMap.set(item.sequence.join(''), item);
  }

  // Lenient scenario:
  // When radical is on the left (operator ⿰) and right child is top-bottom (operator ⿱ or ⿳):
  // Radical can either be beside the top component or the bottom component on a horizontal line.
  if (node.operator === '\u2FF0' && node.components.length === 2) {
    const [leftChild, rightChild] = node.components;
    const rightTree = getNodeTree(rightChild);
    if (rightTree && (rightTree.operator === '\u2FF1' || rightTree.operator === '\u2FF3')) {
      const leftSeqs = sequencesForNode(leftChild, ancestors);
      const rightCompSets = rightTree.components.map(comp => sequencesForNode(comp, ancestors));

      // 1) Radical beside top component: [Left, Top, Bottom]
      const topFirstCombined = combineChildSets(rightCompSets, new Set(['horizontal', 'vertical']));
      for (const l of leftSeqs) {
        for (const r of topFirstCombined) {
          if (l.sequence.length + r.sequence.length <= BOARD_SIZE) {
            const seq = [...l.sequence, ...r.sequence];
            const key = seq.join('');
            if (sequencesMap.has(key)) {
              sequencesMap.get(key).orientations.add('horizontal');
            } else {
              sequencesMap.set(key, {
                sequence: seq,
                orientations: new Set(['horizontal'])
              });
            }
          }
        }
      }

      // 2) Radical beside bottom component: [Left, Bottom, Top]
      const bottomFirstCombined = combineChildSets([...rightCompSets].reverse(), new Set(['horizontal', 'vertical']));
      for (const l of leftSeqs) {
        for (const r of bottomFirstCombined) {
          if (l.sequence.length + r.sequence.length <= BOARD_SIZE) {
            const seq = [...l.sequence, ...r.sequence];
            const key = seq.join('');
            if (sequencesMap.has(key)) {
              sequencesMap.get(key).orientations.add('horizontal');
            } else {
              sequencesMap.set(key, {
                sequence: seq,
                orientations: new Set(['horizontal'])
              });
            }
          }
        }
      }
    }

    const leftTree = getNodeTree(leftChild);
    if (leftTree && (leftTree.operator === '\u2FF1' || leftTree.operator === '\u2FF3')) {
      const rightSeqs = sequencesForNode(rightChild, ancestors);
      const leftCompSets = leftTree.components.map(comp => sequencesForNode(comp, ancestors));

      const topFirstCombined = combineChildSets(leftCompSets, new Set(['horizontal', 'vertical']));
      for (const l of topFirstCombined) {
        for (const r of rightSeqs) {
          if (l.sequence.length + r.sequence.length <= BOARD_SIZE) {
            const seq = [...l.sequence, ...r.sequence];
            const key = seq.join('');
            if (sequencesMap.has(key)) {
              sequencesMap.get(key).orientations.add('horizontal');
            } else {
              sequencesMap.set(key, {
                sequence: seq,
                orientations: new Set(['horizontal'])
              });
            }
          }
        }
      }

      const bottomFirstCombined = combineChildSets([...leftCompSets].reverse(), new Set(['horizontal', 'vertical']));
      for (const l of bottomFirstCombined) {
        for (const r of rightSeqs) {
          if (l.sequence.length + r.sequence.length <= BOARD_SIZE) {
            const seq = [...l.sequence, ...r.sequence];
            const key = seq.join('');
            if (sequencesMap.has(key)) {
              sequencesMap.get(key).orientations.add('horizontal');
            } else {
              sequencesMap.set(key, {
                sequence: seq,
                orientations: new Set(['horizontal'])
              });
            }
          }
        }
      }
    }
  }

  return [...sequencesMap.values()];
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

module.exports = { scoreBoard, validSequences };