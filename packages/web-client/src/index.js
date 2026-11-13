export { esc } from "./esc.js";

/** The page's access token, from its URL. */
export const token = new URLSearchParams(location.search).get("token") ?? "";
/** A server path carrying the token. */
export const withToken = (path) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
/** Reloads the stylesheet the server writes from omp's theme. */
export function reloadAppearance() {
  document.getElementById("appearance").href = `${withToken("/appearance.css")}&t=${Date.now()}`;
}

/** The page's socket to omp, reconnecting with backoff; send returns false while it's down. */
export function connectSocket(onMessage, onConnection) {
  let socket = null;
  let retry = 0;
  const connect = () => {
    socket = new WebSocket(withToken(`ws://${location.host}/ws`));
    socket.onopen = () => {
      retry = 0;
      onConnection(true);
    };
    socket.onmessage = (e) => onMessage(JSON.parse(e.data));
    socket.onclose = () => {
      onConnection(false);
      setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    };
  };
  connect();
  return {
    send(msg) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(msg));
      return true;
    },
  };
}
