const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGameSummary } = require('../summary');

function boardFrom(entries) {
  const board = Array(25).fill('');
  for (const [index, value] of entries) board[index] = value;
  return board;
}

test('buildGameSummary ranks players by score and includes each final board', () => {
  const room = {
    players: [
      { id: 'p1', name: 'Alice', board: boardFrom([[0, '日'], [1, '月']]), score: 2, spectator: false, connected: true },
      { id: 'p2', name: 'Bob', board: boardFrom([[0, '木'], [1, '木'], [2, '林']]), score: 5, spectator: false, connected: true },
      { id: 'p3', name: 'Cora', board: boardFrom([[0, '王'], [1, '木'], [2, '木']]), score: 3, spectator: false, connected: true }
    ]
  };

  const summary = buildGameSummary(room);
  assert.deepEqual(summary.leaderboard.map(player => player.name), ['Bob', 'Cora', 'Alice']);
  assert.equal(summary.leaderboard[0].score, 5);
  assert.deepEqual(summary.leaderboard[0].board.slice(0, 3), ['木', '木', '林']);
  assert.equal(summary.winner.name, 'Bob');
});
