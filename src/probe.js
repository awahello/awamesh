import net from "node:net";

/** 纯 TCP 探测：不关心对端说什么协议，只判断端口是否可连 */
export function tcpProbe(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const started = Date.now();
    const sock = new net.Socket();
    let done = false;

    const finish = (ok, err) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - started, error: err || null });
    };

    sock.setTimeout(timeout);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false, "timeout"));
    sock.once("error", e => finish(false, e.code || e.message));
    sock.connect(port, host);
  });
}
