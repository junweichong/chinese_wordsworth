const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreBoard } = require('../scoring');

function boardWith(entries) {
  const board = Array(25).fill('');
  entries.forEach(([index, tile]) => { board[index] = tile; });
  return board;
}

test('scores nested 草 formation and its 早 subcharacter by tile count', () => {
  const result = scoreBoard(boardWith([[0, '艹'], [5, '日'], [10, '十']]));
  assert.deepEqual(
    result.words.map(word => [word.character, word.positions, word.tileCount]),
    [['早', [5, 10], 2], ['草', [0, 5, 10], 3]]
  );
  assert.equal(result.total, 5);
});

test('scores horizontal and vertical two-tile characters', () => {
  const result = scoreBoard(boardWith([[0, '日'], [1, '月'], [5, '门'], [10, '心']]));
  assert(result.words.some(word => word.character === '明' && word.tileCount === 2 && word.orientation === 'horizontal'));
  assert(result.words.some(word => word.character === '闷' && word.tileCount === 2 && word.orientation === 'vertical'));
  assert.equal(result.total, 4);
});

test('scores nested 琳 and 林 formations by their respective tile counts', () => {
  const result = scoreBoard(boardWith([[0, '王'], [1, '木'], [2, '木']]));
  assert(result.words.some(word => word.character === '林' && word.tileCount === 2));
  assert(result.words.some(word => word.character === '琳' && word.tileCount === 3));
  assert.equal(result.total, 5);
});

test('does not score a single character tile or diagonal-only components', () => {
  assert.equal(scoreBoard(boardWith([[0, '早']])).total, 0);
  assert.equal(scoreBoard(boardWith([[0, '日'], [6, '月']])).total, 0);
});

test('strictly enforces orientation: left-right only horizontal, top-bottom only vertical', () => {
  // 社 is left-right (礻 + 土)
  assert.equal(scoreBoard(boardWith([[0, '礻'], [5, '土']])).words.some(w => w.character === '社'), false); // vertical invalid
  assert.equal(scoreBoard(boardWith([[0, '礻'], [1, '土']])).words.some(w => w.character === '社'), true); // horizontal valid

  // 穷 is top-bottom (穴 + 力)
  assert.equal(scoreBoard(boardWith([[0, '穴'], [1, '力']])).words.some(w => w.character === '穷'), false); // horizontal invalid
  assert.equal(scoreBoard(boardWith([[0, '穴'], [5, '力']])).words.some(w => w.character === '穷'), true); // vertical valid
});

test('allows lenient matching for compound characters (left radical beside top or bottom component)', () => {
  // 樟 is left-right: 木 + 章, where 章 is 音 over 十
  // Radical beside top component horizontally: [木, 音, 十] -> valid
  assert.equal(scoreBoard(boardWith([[0, '木'], [1, '音'], [2, '十']])).words.some(w => w.character === '樟'), true);
  // Radical beside bottom component horizontally: [木, 十, 音] -> valid
  assert.equal(scoreBoard(boardWith([[0, '木'], [1, '十'], [2, '音']])).words.some(w => w.character === '樟'), true);
  // Vertically placed -> invalid for 樟 (since 木 is left radical)
  assert.equal(scoreBoard(boardWith([[0, '木'], [5, '音'], [10, '十']])).words.some(w => w.character === '樟'), false);
});