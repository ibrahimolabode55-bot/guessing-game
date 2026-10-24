const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static("public"));
const server = http.createServer(app);
const io = new Server(server);

// Store all game rooms in memory
const rooms = new Map();

// Create a unique six-character room ID
function generateRoomId() {
  let roomId;

  do {
    roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms.has(roomId));

  return roomId;
}

app.get("/", (req, res) => {
    res.send("Welcome to the Guessing Game!");
});

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  socket.on("create-room", (playerName) => {
    // Check that the player's name is valid
    if (
      typeof playerName !== "string" ||
      playerName.trim().length === 0 ||
      playerName.trim().length > 20
    ) {
      socket.emit("room-error", "Enter a name between 1 and 20 characters.");
      return;
    }

    // Generate a room ID
    const roomId = generateRoomId();

    // Create and store the room
    const room = {
      id: roomId,
      gameMasterId: socket.id,
      players: [
        {
          id: socket.id,
          name: playerName.trim(),
          score: 0
        }
      ],
      status: "waiting"
    };

    rooms.set(roomId, room);

    // Put this socket inside the Socket.IO room
    socket.join(roomId);

    // Send the room details back to the creator
    socket.emit("room-created", {
      roomId: roomId,
      players: room.players,
      status: room.status
    });

    console.log("Room created:", roomId);
  });

  // Handle a player joining a room
  socket.on("join-room", ({ playerName, roomId }) => {
    if (
      typeof playerName !== "string" ||
      playerName.trim().length === 0 ||
      playerName.trim().length > 20
    ) {
      socket.emit("join-error", "Enter a name between 1 and 20 characters.");
      return;
    }

    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("join-error", "Room not found. Check the Room ID.");
      return;
    }

    if (room.status !== "waiting") {
      socket.emit("join-error", "This game has already started.");
      return;
    }

    const player = {
      id: socket.id,
      name: playerName.trim(),
      score: 0
    };

    room.players.push(player);
    socket.join(roomId);

    socket.emit("room-joined", {
      roomId: room.id,
      players: room.players,
      status: room.status
    });

    io.to(roomId).emit("player-list-updated", {
      players: room.players
    });

    console.log(player.name + " joined room " + roomId);
  });

  
  // Handle the game master's question and answer
  socket.on("save-question", ({ question, answer }) => {
    // Find the room this game master owns
    const room = Array.from(rooms.values()).find(
      (room) => 
        room.gameMasterId === socket.id ||
        room.nextGameMasterId === socket.id
    );

    // Only the game master can save the question
    if (!room) {
      socket.emit("question-error", "Only the game master can save a question.");
      return;
    }

    // The question can only be changed before the game starts
    if (room.status !== "waiting" && room.status !== "finished") {
      socket.emit("question-error", "The game has already started.");
      return;
    }

    // Check that both fields contain valid text
    if (
      typeof question !== "string" ||
      typeof answer !== "string" ||
      question.trim().length === 0 ||
      answer.trim().length === 0 ||
      question.trim().length > 500 ||
      answer.trim().length > 100
    ) {
      socket.emit("question-error", "Enter a valid question and answer.");
      return;
    }

    // Store the question and secret answer on the server
    room.question = question.trim();
    room.answer = answer.trim();

    socket.emit("question-saved", "Your question and answer have been saved.");
    console.log("Question saved for room:", room.id);
  });

  // Handle starting the game
  socket.on("start-game", () => {
    // Find the room belonging to this game master
    const room = Array.from(rooms.values()).find(
      (room) => 
        room.gameMasterId === socket.id ||
        room.nextGameMasterId === socket.id
    );

    if (!room) {
      socket.emit("game-error", "Only the game master can start the game.");
      return;
    }

    // The game must still be waiting to start
    if (room.status !== "waiting" && room.status !== "finished") {
      socket.emit("game-error", "The game has already started.");
      return;
    }

    // Require at least three connected players
    if (room.players.length < 3) {
      socket.emit(
        "game-error",
        "At least 3 players must join before the game can start."
      );
      return;
    }

    // Require a saved question and answer
    if (!room.question || !room.answer) {
      socket.emit(
        "game-error",
        "Please save a question and answer before starting."
      );
      return;
    }

    // Update the game master if a new one was selected
    if (room.nextGameMasterId) {
      room.gameMasterId = room.nextGameMasterId;
      room.nextGameMasterId = null;
    }

    // Start the game
    room.status = "playing";
    room.attempts = {};

  room.timer = setTimeout(() => {
   if (room.status !== "playing") {
     return;
   }

   room.status = "finished";

   io.to(room.id).emit("time-up", {
     answer: room.answer,
     players: room.players.map((player) => ({
       name: player.name,
       score: player.score
     }))
   });

   console.log("Time is up in room:", room.id);
 },  60000);

    // Send the question, but never send the secret answer
    io.to(room.id).emit("game-started", {
      question: room.question,
      players: room.players.map((player) => ({
        name: player.name,
        score: player.score
      }))
    });

    console.log("Game started in room:", room.id);
  });

  
  socket.on("submit-guess", ({ guess }) => {
    const room = Array.from(rooms.values()).find(
      (room) => room.players.some((player) => player.id === socket.id)
    );

    if (!room || room.status !== "playing") {
      return;
    }

    const player = room.players.find(
      (player) => player.id === socket.id
    );

    if (typeof guess !== "string" || guess.trim().length === 0) {
      socket.emit("guess-result", {
        message: "Please enter a valid guess."
      });
      return;
    }

    if (room.attempts[socket.id] >= 3) {
      socket.emit("guess-result", {
        message: "You have used all 3 attempts.",
        attemptsLeft: 0
      });
      return;
    }

    room.attempts[socket.id] =
      (room.attempts[socket.id] || 0) + 1;

    if (
      guess.trim().toLowerCase() ===
      room.answer.trim().toLowerCase()
    ) {
      room.status = "finished";
      clearTimeout(room.timer);
      player.score += 10;
      room.nextGameMasterId = player.id;

      io.to(room.id).emit("round-ended", {
        winnerName: player.name,
        answer: room.answer,
        players: room.players.map((player) => ({
          name: player.name,
          score: player.score
        }))
      });

      room.gameMasterId = player.id;
      room.nextGameMasterId = null;
      room.status = "waiting";

      socket.emit("you-won", "You have won!");
      console.log(player.name + " won room " + room.id);
      return;
    }

    const attemptsLeft = 3 - room.attempts[socket.id];

    socket.emit("guess-result", {
      message: "Wrong guess!",
      attemptsLeft: attemptsLeft
    });
  });

  
  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(
        (player) => player.id === socket.id
      );

      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);

        if (room.players.length === 0) {
          if (room.timer) {
            clearTimeout(room.timer);
          }

          rooms.delete(roomId);
          console.log("Room deleted:", roomId);
        } else {
          io.to(roomId).emit("player-list-updated", {
            players: room.players
          });
        }

        break;
      }
    }
  });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Guessing Game is running on port ${PORT}`);
});