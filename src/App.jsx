
import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import "./App.css";

const QUESTIONS = [
  {
    question: "Which language runs in a web browser?",
    options: ["Python", "JavaScript", "C++", "Java"],
    answer: 1,
  },
  {
    question: "What does HTML stand for?",
    options: [
      "HyperText Markup Language",
      "HighText Machine Language",
      "Home Tool Markup Language",
      "Hyper Transfer Main Link",
    ],
    answer: 0,
  },
  {
    question: "Which company created React?",
    options: ["Google", "Microsoft", "Meta", "Amazon"],
    answer: 2,
  },
  {
    question: "Which symbol is used for JavaScript comments on one line?",
    options: ["##", "//", "<!--", "**"],
    answer: 1,
  },
  {
    question: "Which one is a database?",
    options: ["Supabase", "HTML", "CSS", "Vite"],
    answer: 0,
  },
];

function makeRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function App() {
  const [name, setName] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [myPlayer, setMyPlayer] = useState("");
  const [selectedAnswer, setSelectedAnswer] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const isHost = room && room.host_name === myPlayer;
  const questionIndex = room?.current_question ?? 0;
  const question = QUESTIONS[questionIndex];

  useEffect(() => {
    if (!room?.room_code) return;

    let active = true;

    async function loadPlayers() {
      const { data, error } = await supabase
        .from("players")
        .select("*")
        .eq("room_code", room.room_code)
        .order("joined_at", { ascending: true });

      if (!error && active) setPlayers(data || []);
    }

    loadPlayers();

    const channel = supabase
      .channel(`quiz-room-${room.room_code}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rooms",
          filter: `room_code=eq.${room.room_code}`,
        },
        (payload) => {
          if (active && payload.new) setRoom(payload.new);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players",
          filter: `room_code=eq.${room.room_code}`,
        },
        () => loadPlayers()
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [room?.room_code]);

  useEffect(() => {
    setSelectedAnswer(null);
  }, [room?.current_question]);

  async function createRoom() {
    if (!name.trim()) {
      setMessage("Please enter your name first.");
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      let createdRoom = null;

      for (let attempt = 0; attempt < 5; attempt++) {
        const code = makeRoomCode();
        const { data, error } = await supabase
          .from("rooms")
          .insert({
            room_code: code,
            host_name: name.trim(),
            status: "waiting",
            current_question: 0,
          })
          .select()
          .single();

        if (!error) {
          createdRoom = data;
          break;
        }

        if (error.code !== "23505") throw error;
      }

      if (!createdRoom) throw new Error("Could not create a room. Try again.");

      const { error: playerError } = await supabase.from("players").insert({
        room_code: createdRoom.room_code,
        player_name: name.trim(),
        score: 0,
      });

      if (playerError) throw playerError;

      setMyPlayer(name.trim());
      setRoom(createdRoom);
    } catch (error) {
      setMessage(error.message || "Could not create room.");
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom() {
    if (!name.trim() || !roomCodeInput.trim()) {
      setMessage("Enter your name and room code.");
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const code = roomCodeInput.trim().toUpperCase();

      const { data: foundRoom, error: roomError } = await supabase
        .from("rooms")
        .select("*")
        .eq("room_code", code)
        .maybeSingle();

      if (roomError) throw roomError;
      if (!foundRoom) throw new Error("Room not found. Check the room code.");

      const { error: playerError } = await supabase.from("players").insert({
        room_code: code,
        player_name: name.trim(),
        score: 0,
      });

      if (playerError) {
        if (playerError.code === "23505") {
          throw new Error("This name is already in the room. Use another name.");
        }
        throw playerError;
      }

      setMyPlayer(name.trim());
      setRoom(foundRoom);
    } catch (error) {
      setMessage(error.message || "Could not join room.");
    } finally {
      setBusy(false);
    }
  }

  async function startGame() {
    if (!isHost) return;

    const { error } = await supabase
      .from("rooms")
      .update({ status: "playing", current_question: 0 })
      .eq("room_code", room.room_code);

    if (error) setMessage(error.message);
  }

  async function submitAnswer(index) {
    if (selectedAnswer !== null || !question || room.status !== "playing") {
      return;
    }

    setSelectedAnswer(index);

    const correct = index === question.answer;

    try {
      const { error: answerError } = await supabase.from("answers").insert({
        room_code: room.room_code,
        player_name: myPlayer,
        question_index: questionIndex,
        answer_index: index,
        is_correct: correct,
      });

      if (answerError) {
        if (answerError.code === "23505") {
          setMessage("You have already answered this question.");
          return;
        }
        throw answerError;
      }

      if (correct) {
        const currentPlayer = players.find(
          (player) => player.player_name === myPlayer
        );

        const { error: scoreError } = await supabase
          .from("players")
          .update({ score: (currentPlayer?.score || 0) + 10 })
          .eq("room_code", room.room_code)
          .eq("player_name", myPlayer);

        if (scoreError) throw scoreError;
      }

      setMessage(correct ? "Correct! +10 points 🎉" : "Not quite. Try the next one!");
    } catch (error) {
      setMessage(error.message || "Could not save your answer.");
    }
  }

  async function nextQuestion() {
    if (!isHost) return;

    const next = questionIndex + 1;

    const { error } = await supabase
      .from("rooms")
      .update({
        current_question: next,
        status: next >= QUESTIONS.length ? "finished" : "playing",
      })
      .eq("room_code", room.room_code);

    if (error) setMessage(error.message);
    else setMessage("");
  }

  async function leaveRoom() {
    if (room && myPlayer) {
      await supabase
        .from("players")
        .delete()
        .eq("room_code", room.room_code)
        .eq("player_name", myPlayer);
    }

    setRoom(null);
    setPlayers([]);
    setMyPlayer("");
    setMessage("");
    setSelectedAnswer(null);
  }

  const leaderboard = [...players].sort((a, b) => b.score - a.score);

  return (
    <main className="app">
      <section className="hero">
        <p className="eyebrow">TRIVIA PARTY</p>
        <h1>Quiz<span>Battle</span></h1>
        <p className="subtitle">Challenge your friends. Prove your knowledge.</p>
      </section>

      {!room ? (
        <section className="panel">
          <label htmlFor="player-name">YOUR NAME</label>
          <input
            id="player-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Enter your name"
            maxLength={30}
          />

          <button className="button primary" onClick={createRoom} disabled={busy}>
            {busy ? "Please wait..." : "+ Create a Room"}
          </button>

          <div className="separator">OR JOIN YOUR FRIENDS</div>

          <label htmlFor="room-code">ROOM CODE</label>
          <input
            id="room-code"
            value={roomCodeInput}
            onChange={(event) =>
              setRoomCodeInput(event.target.value.toUpperCase())
            }
            placeholder="Enter 6-character code"
            maxLength={6}
          />

          <button className="button primary" onClick={joinRoom} disabled={busy}>
            Join a Room
          </button>

          {message && <p className="notice">{message}</p>}
          <p className="privacy-note">✨ No account required for this demo</p>
        </section>
      ) : (
        <section className="panel">
          <div className="room-heading">
            <p>ROOM CODE</p>
            <h2>{room.room_code}</h2>
            <button
              className="button secondary"
              onClick={() => navigator.clipboard?.writeText(room.room_code)}
            >
              Copy Room Code
            </button>
          </div>

          <h3>Players ({players.length})</h3>
          <ul className="player-list">
            {leaderboard.map((player) => (
              <li key={player.id}>
                <span>
                  {player.player_name}
                  {player.player_name === room.host_name ? " 👑" : ""}
                  {player.player_name === myPlayer ? " (You)" : ""}
                </span>
                <strong>{player.score} pts</strong>
              </li>
            ))}
          </ul>

          {room.status === "waiting" && (
            <>
              <p>Share the room code with your friends.</p>
              {isHost ? (
                <button className="button primary" onClick={startGame}>
                  Start Quiz
                </button>
              ) : (
                <p>Waiting for the host to start the quiz...</p>
              )}
            </>
          )}

          {room.status === "playing" && question && (
            <div className="quiz-card">
              <p className="eyebrow">
                QUESTION {questionIndex + 1} OF {QUESTIONS.length}
              </p>
              <h2>{question.question}</h2>

              <div className="answers">
                {question.options.map((option, index) => (
                  <button
                    key={option}
                    className={`button answer ${
                      selectedAnswer === index ? "selected" : ""
                    }`}
                    disabled={selectedAnswer !== null}
                    onClick={() => submitAnswer(index)}
                  >
                    {String.fromCharCode(65 + index)}. {option}
                  </button>
                ))}
              </div>

              {message && <p className="notice">{message}</p>}

              {isHost && (
                <button className="button primary" onClick={nextQuestion}>
                  {questionIndex === QUESTIONS.length - 1
                    ? "Show Winner"
                    : "Next Question"}
                </button>
              )}
            </div>
          )}

          {room.status === "finished" && (
            <div className="quiz-card">
              <p className="eyebrow">QUIZ COMPLETE</p>
              <h2>🏆 Winner</h2>
              <h3>{leaderboard[0]?.player_name || "No players"}</h3>
              <p>Final score: {leaderboard[0]?.score || 0} points</p>
              <h3>Leaderboard</h3>
              <ol>
                {leaderboard.map((player) => (
                  <li key={player.id}>
                    {player.player_name} — {player.score} points
                  </li>
                ))}
              </ol>
            </div>
          )}

          {message && room.status === "waiting" && (
            <p className="notice">{message}</p>
          )}

          <button className="button secondary" onClick={leaveRoom}>
            Leave Room
          </button>
        </section>
      )}
    </main>
  );
}

export default App;
