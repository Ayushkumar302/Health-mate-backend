// the shared Socket.io server, so the REST API can push live updates (e.g. new messages)
let io;
export const setIO = server => {
  io = server;
};
export const getIO = () => io;

// every connected socket joins the room of its account, so "send to this person" reaches all their tabs
export const personRoom = (role, id) => `${role === "doctor" ? "doctor" : "user"}:${id}`;
