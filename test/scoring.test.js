const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreBoard, getClaimPositions, validateWordClaim } = require('../scoring');

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

test('rejects 1D linear flattening of compound characters with mixed orientations', () => {
  // 樟 is left-right: 木 + 章, where 章 is top-bottom (音 over 十)
  // In a 1D straight line, neither [木, 音, 十] nor [木, 十, 音] forms 樟
  assert.equal(scoreBoard(boardWith([[0, '木'], [1, '音'], [2, '十']])).words.some(w => w.character === '樟'), false);
  assert.equal(scoreBoard(boardWith([[0, '木'], [1, '十'], [2, '音']])).words.some(w => w.character === '樟'), false);
  assert.equal(scoreBoard(boardWith([[0, '木'], [5, '音'], [10, '十']])).words.some(w => w.character === '樟'), false);
});

test('getClaimPositions calculates positions and orientation correctly', () => {
  assert.deepEqual(getClaimPositions(0, 1), { positions: [0, 1], orientation: 'horizontal' });
  assert.deepEqual(getClaimPositions(0, 2), { positions: [0, 1, 2], orientation: 'horizontal' });
  assert.deepEqual(getClaimPositions(0, 5), { positions: [0, 5], orientation: 'vertical' });
  assert.deepEqual(getClaimPositions(0, 10), { positions: [0, 5, 10], orientation: 'vertical' });
  assert.equal(getClaimPositions(0, 0), null); // length 1 is invalid
  assert.equal(getClaimPositions(0, 6), null); // diagonal is invalid
  assert.equal(getClaimPositions(1, 0), null); // backwards invalid (must be normalized start <= end)
});

test('validateWordClaim validates character sequences and orientations', () => {
  const board = boardWith([[0, '日'], [1, '月'], [5, '穴'], [10, '力'], [15, '王'], [16, '木'], [17, '木']]);

  // Valid horizontal 2-tile
  const claimMing = validateWordClaim(board, 0, 1);
  assert.equal(claimMing.valid, true);
  assert.equal(claimMing.sequence, '日月');
  assert.deepEqual(claimMing.characters, ['明']);
  assert.equal(claimMing.tileCount, 2);

  // Valid vertical 2-tile
  const claimQiong = validateWordClaim(board, 5, 10);
  assert.equal(claimQiong.valid, true);
  assert.equal(claimQiong.sequence, '穴力');
  assert.deepEqual(claimQiong.characters, ['穷']);

  // Sub-word claims: [15, 17] for 琳 (3 tiles) and [16, 17] for 林 (2 tiles)
  const claimLin3 = validateWordClaim(board, 15, 17);
  assert.equal(claimLin3.valid, true);
  assert.deepEqual(claimLin3.characters, ['琳']);
  assert.equal(claimLin3.tileCount, 3);

  const claimLin2 = validateWordClaim(board, 16, 17);
  assert.equal(claimLin2.valid, true);
  assert.deepEqual(claimLin2.characters, ['林']);
  assert.equal(claimLin2.tileCount, 2);

  // Wrong orientation rejection
  const wrongOrient = validateWordClaim(boardWith([[0, '穴'], [1, '力']]), 0, 1);
  assert.equal(wrongOrient.valid, false);

  // Empty cell rejection
  const withEmpty = validateWordClaim(board, 0, 2);
  assert.equal(withEmpty.valid, false);
});

test('validateWordClaim validates non-linear adjacent tiles matching radical positions', () => {
  // L-shape for 樟: 木 at (0,0)[0], 音 at (0,1)[1], 十 at (1,1)[6]
  const boardZhang = boardWith([[0, '木'], [1, '音'], [6, '十']]);
  const claimZhang = validateWordClaim(boardZhang, [0, 1, 6]);
  assert.equal(claimZhang.valid, true);
  assert.deepEqual(claimZhang.characters, ['樟']);
  assert.equal(claimZhang.tileCount, 3);
  assert.equal(claimZhang.orientation, 'adjacent');

  // L-shape for 想: 木 at (0,0)[0], 目 at (0,1)[1], 心 at (1,0)[5]
  const boardXiang = boardWith([[0, '木'], [1, '目'], [5, '心']]);
  const claimXiang = validateWordClaim(boardXiang, [0, 1, 5]);
  assert.equal(claimXiang.valid, true);
  assert.deepEqual(claimXiang.characters, ['想']);
  assert.equal(claimXiang.tileCount, 3);
  assert.equal(claimXiang.orientation, 'adjacent');

  // Invalid: 心 on top of 相 for 想: 心 at (0,0)[0], 木 at (1,0)[5], 目 at (1,1)[6]
  const boardXiangInv = boardWith([[0, '心'], [5, '木'], [6, '目']]);
  const claimXiangInv = validateWordClaim(boardXiangInv, [0, 5, 6]);
  assert.equal(claimXiangInv.valid, false);

  // Disconnected tiles (not adjacent): 0 and 2
  const claimDisconn = validateWordClaim(boardWith([[0, '日'], [2, '月']]), [0, 2]);
  assert.equal(claimDisconn.valid, false);
  assert.equal(claimDisconn.error, '所选字块必须相互相邻。');
});

test('components and characters are strictly distinct and not interchangeable', () => {
  // 休 is composed of component 亻 and character 木
  const claimXiuValid = validateWordClaim(boardWith([[0, '亻'], [1, '木']]), [0, 1]);
  assert.equal(claimXiuValid.valid, true);
  assert.deepEqual(claimXiuValid.characters, ['休']);

  // Character 人 cannot substitute component 亻 for 休
  const claimXiuInvalid = validateWordClaim(boardWith([[0, '人'], [1, '木']]), [0, 1]);
  assert.equal(claimXiuInvalid.valid, false);

  // 从 is composed of character 人 and character 人
  const claimCongValid = validateWordClaim(boardWith([[0, '人'], [1, '人']]), [0, 1]);
  assert.equal(claimCongValid.valid, true);
  assert.deepEqual(claimCongValid.characters, ['从']);

  // Component 亻 cannot substitute character 人 for 从
  const claimCongInvalid = validateWordClaim(boardWith([[0, '亻'], [1, '人']]), [0, 1]);
  assert.equal(claimCongInvalid.valid, false);

  // 江 is composed of component 氵 and character 工
  const claimJiangValid = validateWordClaim(boardWith([[0, '氵'], [1, '工']]), [0, 1]);
  assert.equal(claimJiangValid.valid, true);
  assert.deepEqual(claimJiangValid.characters, ['江']);

  // Character 水 cannot substitute component 氵 for 江
  const claimJiangInvalid = validateWordClaim(boardWith([[0, '水'], [1, '工']]), [0, 1]);
  assert.equal(claimJiangInvalid.valid, false);
});


test('recognizes previously incomplete Tier 1 characters and newly added Tier 2 characters', () => {
  // 往 was previously incomplete in Tier 1
  const claimWang = validateWordClaim(boardWith([[0, '彳'], [1, '主']]), [0, 1]);
  assert.equal(claimWang.valid, true);
  assert(claimWang.characters.includes('往'));

  // 兀 is in Tier 2 (rank 3503: 一 over 儿)
  const claimWu = validateWordClaim(boardWith([[0, '一'], [5, '儿']]), [0, 5]);
  assert.equal(claimWu.valid, true);
  assert(claimWu.characters.includes('兀'));
});
