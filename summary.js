const { scoreBoard } = require('./scoring');

function buildGameSummary(room) {
  const players = (room?.players || []).map(player => {
    const board = Array.isArray(player.board) ? player.board.slice() : Array(25).fill('');
    const scored = scoreBoard(board);
    return {
      playerId: player.id,
      playerName: player.name,
      score: Number(player.score ?? scored.total ?? 0),
      spectator: player.spectator === true,
      connected: player.connected !== false,
      board,
      words: Array.isArray(player.matches) ? player.matches.slice() : scored.words
    };
  });

  const leaderboard = players
    .filter(player => !player.spectator)
    .sort((left, right) => right.score - left.score || left.playerName.localeCompare(right.playerName))
    .map((player, index) => ({
      ...player,
      name: player.playerName,
      playerName: player.playerName,
      rank: index + 1
    }));

  return {
    leaderboard,
    winner: leaderboard[0] || null,
    players
  };
}

module.exports = { buildGameSummary };
