import { cfg, log } from "../config.js";
import { mockBackend } from "./mock.js";
import { headscaleBackend } from "./headscale.js";
import { wgBackend } from "./wg.js";

let active = null;

export function backend() {
  if (active) return active;
  if (cfg.backend === "wg") {
    log("[backend] 使用 wg：管理你自己的 WireGuard 服务端（真实密钥与配置）");
    active = wgBackend;
  } else if (cfg.backend === "headscale") {
    log("[backend] 使用 headscale CLI：" + cfg.headscaleCmd);
    active = headscaleBackend;
  } else {
    log("[backend] 使用 mock（本地演示数据，接入真实控制面请设 AWA_BACKEND=headscale）");
    active = mockBackend;
  }
  return active;
}
