/**
 * 浏览器半边：输入框工具行里的用量胶囊 + 弹出面板。
 *
 * - 注册点：conversation.input.right（list 槽，单行高，位于模型选择框左侧）；
 * - 数据：宿主路由 /plugins/dsh-opencode-go-pool/state?session=<sid>，关闭时 20s 轮询、
 *   打开时 5s 轮询，点「刷新」走 POST /refresh 强制打上游；
 * - 面板：每个账号一行——月用量条、5h/周用量、距重置天数、评分、采样曲线、
 *   本会话钉号标记；底部写明公式与「改配置不用重启」。
 *
 * 手写 ModuleLoader bundle（无构建步骤）：require 只取平台种子里的 react。
 */
window.__ModuleLoader__.load({
  id: "dsh-opencode-go-pool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    // 平台静态模块表里有 react / react/jsx-runtime / react-dom / react-dom/client。
    // 面板用 portal 挂到 body：插件槽位所在的祖先可能带 transform/filter，
    // 那样 position:fixed 会相对祖先而不是视口定位，坐标算得再对也会整体右移出窗口。
    var ReactDOM = null;
    try { ReactDOM = require("react-dom"); } catch (error) { ReactDOM = null; }
    var createPortal = ReactDOM && typeof ReactDOM.createPortal === "function" ? ReactDOM.createPortal : null;
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;
    var useMemo = React.useMemo || function (factory) { return factory(); };
    /** React 18 的 useSyncExternalStore；缺失时退化成一次性读取（不订阅）。 */
    var useSyncExternalStore = React.useSyncExternalStore
      || function (_subscribe, getSnapshot) { return getSnapshot(); };

    /** 会话级模型选择服务（ctx.modelDirectories）：首选信号源。 */
    var modelDirectories = null;
    /** 会话服务（ctx.sessions）：备用信号源（读 modelSelection 投影）。 */
    var sessionService = null;
    /** 诊断采样（只记最后一次判定，供宿主写 diag.json 排查显隐问题）。 */
    var lastDiag = "";

    var STATE_URL = "/plugins/dsh-opencode-go-pool/state";
    var REFRESH_URL = "/plugins/dsh-opencode-go-pool/refresh";
    var DIAG_URL = "/plugins/dsh-opencode-go-pool/diag";
    /** 账号增删改路由（宿主改写 config.json + 凭证）。 */
    var ACCOUNTS_URL = "/plugins/dsh-opencode-go-pool/accounts";
    var PANEL_WIDTH = 372;
    var CLOSED_POLL_MS = 20000;
    var OPEN_POLL_MS = 5000;

    /**
     * 取某会话的模型选择「快照店」。
     *
     * 注意：modelDirectories.directoryFor(sessionId) 返回的是 ModelDirectory，
     * 真正有 subscribe/getSnapshot 的是它的 .store（官方 ModelSelect 也是用 .store）。
     * 这里兼容两种形状，拿不到就返回 null（退化为常显，绝不让渲染抛错）。
     */
    /** 上报一次显隐判定（节流；失败静默，纯诊断用）。 */
    function reportDiag(diag) {
      var text = JSON.stringify(diag);
      if (text === lastDiag) return;
      lastDiag = text;
      try {
        fetch(DIAG_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: text,
        }).catch(function () {});
      } catch (error) { /* 诊断不上报也不影响 UI */ }
    }

    /**
     * 取某会话「当前选中的模型」的读取器。
     *
     * 两条独立路径，谁先可用用谁（都拿不到就返回 null，退化为常显）：
     *   A. ctx.modelDirectories.directoryFor(sid).store —— 官方 ModelSelect 用的同一个快照店，
     *      快照里 current = {provider, model, reasoningEffort}；
     *   B. ctx.sessions.binding(sid).session.projections.faceOf('modelSelection') ——
     *      目录内部也是从这里读「会话持久化的模型选择」，值是 {next:{provider,...}} 或直接是选择项。
     *
     * @returns {{read: () => {provider?: string}|undefined, subscribe: (fn) => () => void, source: string}|null}
     */
    function selectionReader(sessionId) {
      if (!sessionId) return null;
      if (modelDirectories !== null) {
        try {
          var directory = modelDirectories.directoryFor(sessionId);
          var store = directory && (directory.store || directory);
          if (store && typeof store.subscribe === "function" && typeof store.getSnapshot === "function") {
            return {
              source: "directory",
              subscribe: function (onChange) { return store.subscribe(onChange); },
              read: function () {
                var snapshot = store.getSnapshot();
                return snapshot && snapshot.current ? snapshot.current : undefined;
              },
              select: function (next) { return directory.select(next); },
            };
          }
        } catch (error) { /* 落到路径 B */ }
      }
      if (sessionService !== null) {
        try {
          var binding = sessionService.binding(sessionId);
          var projection = binding && binding.session && binding.session.projections
            ? binding.session.projections.faceOf("modelSelection")
            : null;
          if (projection && typeof projection.getSnapshot === "function") {
            return {
              source: "projection",
              subscribe: function (onChange) { return projection.subscribe(onChange); },
              read: function () {
                var value = projection.getSnapshot();
                var next = value && value.next !== undefined ? value.next : value;
                return next && next.provider ? next : undefined;
              },
            };
          }
        } catch (error) { /* 两条路都不通 */ }
      }
      return null;
    }

    /**
     * 订阅会话当前的模型选择。
     * @returns {{provider?: string, model?: string}|null} 选择项（拿不到时为 null）。
     */
    function useModelSelection(sessionId) {
      var reader = selectionReader(sessionId);
      var subscribe = useMemo(function () {
        return reader === null ? function () { return function () {}; } : reader.subscribe;
      }, [reader]);
      var getSnapshot = useMemo(function () {
        return function () {
          if (reader === null) return null;
          try {
            return reader.read() || null;
          } catch (error) {
            return null;
          }
        };
      }, [reader]);
      return useSyncExternalStore(subscribe, getSnapshot);
    }

    /** 胶囊主色：按月用量分档。 */
    function toneOf(percent) {
      if (typeof percent !== "number") return "#8a8a8a";
      if (percent >= 95) return "#e5484d";
      if (percent >= 80) return "#e0a020";
      if (percent >= 50) return "#4f8cff";
      return "#30a46c";
    }

    /** 数字格式化：undefined → —。 */
    function fmt(value, digits) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return value.toFixed(digits === undefined ? 0 : digits);
    }

    /**
     * 胶囊该显示谁的用量。
     *
     * 用户看胶囊是为了知道「我正在用的这个套餐还剩多少」，所以：
     *   · 本会话已绑定账号（accounts 里 pinned=true）→ 显示**那个号**的月用量；
     *   · 还没绑定（新会话）→ 显示全池平均，作为「这一轮会用到谁」的参考。
     *
     * @param {Array<object>} accounts 账号列表（含 pinned / monthly.percent / label）。
     * @param {number|undefined} poolPercent 全池平均（兜底用）。
     * @returns {{percent: number|undefined, label: string, bound: boolean}}
     */
    function chipUsage(accounts, poolPercent) {
      var list = Array.isArray(accounts) ? accounts : [];
      for (var i = 0; i < list.length; i += 1) {
        var account = list[i];
        if (!account || account.pinned !== true) continue;
        var own = account.monthly && typeof account.monthly.percent === "number" && isFinite(account.monthly.percent)
          ? account.monthly.percent
          : undefined;
        return { percent: own, label: typeof account.label === "string" ? account.label : "", bound: true };
      }
      return { percent: poolPercent, label: "", bound: false };
    }

    /** 距重置的人话。 */
    function daysText(days) {
      if (typeof days !== "number" || !Number.isFinite(days)) return "重置时间未知";
      if (days <= 0) return "已到重置点";
      if (days < 1) return (days * 24).toFixed(1) + " 小时后重置";
      return days.toFixed(1) + " 天后重置";
    }

    /** 轻量曲线：把采样点画成 polyline（x=时间，y=月用量%）。 */
    function Sparkline(props) {
      var samples = props.samples || [];
      var width = props.width || 96;
      var height = props.height || 26;
      if (samples.length < 2) {
        return h("div", {
          style: { width: width, height: height, display: "flex", alignItems: "center", justifyContent: "flex-end", fontSize: 10, opacity: 0.45 },
        }, "暂无曲线");
      }
      var first = samples[0].t;
      var last = samples[samples.length - 1].t;
      var span = Math.max(last - first, 1);
      var points = samples.map(function (sample) {
        var x = ((sample.t - first) / span) * (width - 2) + 1;
        var y = height - 2 - (Math.min(Math.max(sample.m, 0), 100) / 100) * (height - 4);
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      return h("svg", { width: width, height: height, viewBox: "0 0 " + width + " " + height, style: { display: "block" } },
        h("line", { x1: 0, y1: height - 2, x2: width, y2: height - 2, stroke: "currentColor", strokeOpacity: 0.15, strokeWidth: 1 }),
        h("polyline", { points: points, fill: "none", stroke: props.color || "#4f8cff", strokeWidth: 1.6, strokeLinejoin: "round", strokeLinecap: "round" }),
        h("circle", {
          cx: ((last - first) / span) * (width - 2) + 1,
          cy: height - 2 - (Math.min(Math.max(samples[samples.length - 1].m, 0), 100) / 100) * (height - 4),
          r: 2,
          fill: props.color || "#4f8cff",
        }));
    }

    /** 月用量细条。 */
    function UsageBar(props) {
      var percent = typeof props.percent === "number" ? Math.min(Math.max(props.percent, 0), 100) : 0;
      return h("div", {
        style: { position: "relative", height: 4, borderRadius: 2, background: "currentColor", opacity: 0.9, overflow: "hidden" },
      }, h("div", {
        style: {
          position: "absolute", inset: 0, width: percent + "%",
          background: toneOf(props.percent), borderRadius: 2,
          opacity: 1,
        },
      }));
    }

    /** 一行账号（含面板上的停用/删除操作）。 */
    function AccountRow(props) {
      var account = props.account;
      var monthly = account.monthly || {};
      var percent = monthly.percent;
      var tone = toneOf(percent);
      var disabled = account.enabled === false;
      var dim = disabled || account.exhausted === true || account.cooldownUntil !== undefined;
      var local = account.local || {};
      var [confirming, setConfirming] = useState(false);
      var badges = [];
      if (disabled) badges.push("已停用");
      if (account.pinned) badges.push("本会话");
      if (account.exhausted) badges.push("月额度已满");
      else if (account.cooldownUntil) badges.push("冷却中");
      if (account.error) badges.push("用量查询失败");

      var smallButton = function (label, onClick, extraStyle) {
        return h("button", {
          type: "button",
          onClick: onClick,
          style: {
            height: 20, padding: "0 7px", borderRadius: 5, cursor: "pointer", fontSize: 10.5,
            border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))",
            background: "transparent", color: "inherit", opacity: 0.75,
            ...extraStyle,
          },
        }, label);
      };

      return h("div", {
        style: {
          display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 10px",
          padding: "8px 10px", borderRadius: 8,
          background: account.pinned ? "rgba(79,140,255,0.10)" : "transparent",
          border: "1px solid " + (account.pinned ? "rgba(79,140,255,0.35)" : "transparent"),
          opacity: dim ? 0.62 : 1,
        },
      },
        // 第一行：标签 + 用量
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
          h("span", { style: { width: 7, height: 7, borderRadius: 4, background: tone, flex: "0 0 auto" } }),
          h("span", { style: { fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, account.label),
          badges.length > 0 && h("span", {
            style: { fontSize: 10, padding: "0 5px", borderRadius: 6, border: "1px solid currentColor", opacity: 0.6, whiteSpace: "nowrap" },
          }, badges.join(" · ")),
        ),
        h("div", { style: { fontSize: 12, fontVariantNumeric: "tabular-nums", textAlign: "right", color: tone } },
          fmt(percent) + "%"),
        // 第二行：条 + 曲线
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } },
          h(UsageBar, { percent: percent }),
          h("div", {
            style: { display: "flex", gap: 10, fontSize: 10.5, opacity: 0.7, flexWrap: "wrap" },
          },
            h("span", { title: "5 小时滚动窗口" }, "5h " + fmt(account.rolling && account.rolling.percent) + "%"),
            h("span", { title: "周窗口" }, "周 " + fmt(account.weekly && account.weekly.percent) + "%"),
            h("span", { title: "距套餐重置" }, daysText(account.daysLeft)),
            h("span", { title: "评分 =（100-月用量%）/ max(距重置天数 - " + props.reserveDays + ", 0)" }, "分 " + account.scoreText),
            account.cache && typeof account.cache.hitRate === "number" && h("span", {
              title: "prompt cache 命中率 = cached /（输入 + cached）；已命中 " + fmt(account.cache.hitRequests) + " 次",
            }, "缓存 " + Math.round(account.cache.hitRate * 100) + "%"),
          ),
        ),
        h("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 } },
          h(Sparkline, { samples: account.samples, color: tone }),
          h("span", { style: { fontSize: 10, opacity: 0.5, fontVariantNumeric: "tabular-nums" } },
            "$" + (typeof local.usd === "number" ? local.usd.toFixed(5) : "0.00000") + " / " + fmt(local.requests) + " 次"),
        ),
        // 第三行：操作
        h("div", { style: { gridColumn: "1 / -1", display: "flex", gap: 6, paddingTop: 2 } },
          smallButton(disabled ? "启用" : "停用", function () {
            props.onAction("toggle", { id: account.id, enabled: disabled });
          }),
          smallButton(confirming ? "确认删除？" : "删除", function () {
            if (confirming) {
              props.onAction("remove", { id: account.id });
              setConfirming(false);
              return;
            }
            setConfirming(true);
          }, confirming ? { borderColor: "#e5484d", color: "#e5484d", opacity: 1 } : null),
          account.apiKeyEnv && h("span", {
            style: { marginLeft: "auto", alignSelf: "center", fontSize: 10, opacity: 0.4, fontFamily: "monospace" },
            title: "凭据引用（~/.dsh/.credentials.yaml 的 refs 键）",
          }, account.apiKeyEnv),
        ),
      );
    }

    /** 主组件：用量胶囊 + 弹出面板。 */
    function UsageChip(props) {
      // 会话 id 来自插槽标准件：0.2.x 直接给 props.sessionId；
      // 老版本挂在 props.session.sessionId 上，两种都读。
      var sessionId = props ? (props.sessionId || (props.session && props.session.sessionId)) : undefined;
      var [data, setData] = useState(null);
      var [open, setOpen] = useState(false);
      var [busy, setBusy] = useState(false);
      var [error, setError] = useState(null);
      // 添加账号的内联表单
      var [formOpen, setFormOpen] = useState(false);
      var [formLabel, setFormLabel] = useState("");
      var [formKey, setFormKey] = useState("");
      var [formBusy, setFormBusy] = useState(false);
      var buttonRef = useRef(null);
      var panelRef = useRef(null);
      // 面板锚点：只给 top 或 bottom 其一（向上开用 bottom，向下开用 top），
      // 外加按窗口算出来的宽度与最大高度——保证任何窗口尺寸下都不越界。
      var [anchor, setAnchor] = useState({ left: 8, top: undefined, bottom: 8, maxHeight: 400, width: PANEL_WIDTH });
      var openRef = useRef(false);

      openRef.current = open;

      var sessionQuery = sessionId ? "?session=" + encodeURIComponent(sessionId) : "";

      useEffect(function () {
        var cancelled = false;
        var timer = undefined;
        function schedule() {
          if (cancelled) return;
          timer = setTimeout(load, openRef.current ? OPEN_POLL_MS : CLOSED_POLL_MS);
        }
        function load() {
          fetch(STATE_URL + sessionQuery, { headers: { accept: "application/json" } })
            .then(function (response) {
              if (!response.ok) throw new Error("HTTP " + response.status);
              return response.json();
            })
            .then(function (payload) {
              if (cancelled) return;
              setData(payload);
              setError(payload && payload.ok === false ? payload.error || "配置错误" : null);
            })
            .catch(function (failure) {
              if (!cancelled) setError(String(failure && failure.message ? failure.message : failure));
            })
            .finally(schedule);
        }
        load();
        return function () {
          cancelled = true;
          if (timer !== undefined) clearTimeout(timer);
        };
      }, [sessionQuery]);

      /**
       * 按按钮位置算面板坐标与尺寸：
       * - 上方空间够就向上开（bottom 定位），否则向下开（top 定位）；
       * - 最大高度取「屏高 62%」与「那一侧可用空间」的较小值，超出就在面板内部滚动；
       * - 宽度不超过窗口，横向也夹在边距内。这样任何窗口尺寸都不会溢出 DSH Desktop。
       */
      var computeAnchor = useCallback(function () {
        var button = buttonRef.current;
        if (!button) return;
        var rect = button.getBoundingClientRect();
        var margin = 8;
        var viewportW = window.innerWidth || document.documentElement.clientWidth || PANEL_WIDTH;
        var viewportH = window.innerHeight || document.documentElement.clientHeight || 600;
        // 窗口再窄也不横向出界（至少留出左右各 8px 的话放不下，就按窗口宽度收）。
        var width = Math.min(PANEL_WIDTH, Math.max(viewportW - margin * 2, 200));
        var left = Math.min(
          Math.max(rect.left + rect.width - width, margin),
          Math.max(viewportW - width - margin, margin),
        );
        var spaceAbove = rect.top - margin;
        var spaceBelow = viewportH - rect.bottom - margin;
        // 默认向上开；上方明显更挤时才往下开。
        var openUp = spaceAbove >= Math.min(spaceBelow, 320);
        var available = Math.max(openUp ? spaceAbove : spaceBelow, 96);
        var maxHeight = Math.max(96, Math.min(Math.round(viewportH * 0.62), Math.round(available)));
        if (openUp) {
          setAnchor({
            left: left, top: undefined,
            bottom: Math.max(viewportH - rect.top + margin, margin),
            maxHeight: maxHeight, width: width,
          });
          return;
        }
        setAnchor({
          left: left, top: Math.max(rect.bottom + margin, margin),
          bottom: undefined, maxHeight: maxHeight, width: width,
        });
      }, []);

      var onOpen = useCallback(function () {
        computeAnchor();
        setOpen(function (value) { return !value; });
      }, [computeAnchor]);

      // 窗口尺寸变化时重算锚点（面板开着也别飘出窗口）。
      useEffect(function () {
        if (!open) return undefined;
        function reposition() { computeAnchor(); }
        window.addEventListener("resize", reposition);
        return function () { window.removeEventListener("resize", reposition); };
      }, [open, computeAnchor]);

      // 兜底校正：万一还有缩放/滚动容器导致偏移，渲染后量一次真实矩形，
      // 哪个方向越界就把整块面板挪回来。挪到界内后 dx/dy 归零，不会来回抖。
      useEffect(function () {
        if (!open) return;
        var node = panelRef.current;
        if (!node || typeof node.getBoundingClientRect !== "function") return;
        var rect = node.getBoundingClientRect();
        var margin = 8;
        var viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
        var viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
        var dx = 0;
        var dy = 0;
        if (rect.right > viewportW - margin) dx = (viewportW - margin) - rect.right;
        if (rect.left + dx < margin) dx = margin - rect.left;
        if (rect.bottom > viewportH - margin) dy = (viewportH - margin) - rect.bottom;
        if (rect.top + dy < margin) dy = margin - rect.top;
        // 把真实几何落进 diag.json：下次若再越界，直接看数字就知道是算法还是渲染层的锅。
        reportDiag({
          panel: {
            l: Math.round(rect.left), r: Math.round(rect.right),
            t: Math.round(rect.top), b: Math.round(rect.bottom),
            w: Math.round(rect.width), h: Math.round(rect.height),
          },
          viewport: { w: Math.round(viewportW), h: Math.round(viewportH) },
          fix: { dx: Math.round(dx), dy: Math.round(dy) },
          portal: createPortal !== null,
        });
        if (dx === 0 && dy === 0) return;
        setAnchor(function (current) {
          var next = { ...current, left: Math.max(margin, Math.round(current.left + dx)) };
          if (current.top !== undefined) next.top = Math.max(margin, Math.round(current.top + dy));
          else next.bottom = Math.max(margin, Math.round((current.bottom === undefined ? margin : current.bottom) - dy));
          return next;
        });
      }, [open, data, anchor.left, anchor.top, anchor.bottom]);

      useEffect(function () {
        if (!open) return undefined;
        function onDocDown(event) {
          if (panelRef.current && panelRef.current.contains(event.target)) return;
          if (buttonRef.current && buttonRef.current.contains(event.target)) return;
          setOpen(false);
        }
        function onKey(event) {
          if (event.key === "Escape") setOpen(false);
        }
        document.addEventListener("mousedown", onDocDown);
        document.addEventListener("keydown", onKey);
        return function () {
          document.removeEventListener("mousedown", onDocDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      var onRefresh = useCallback(function () {
        setBusy(true);
        fetch(REFRESH_URL + sessionQuery, { method: "POST", headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (payload) {
            setData(payload);
            setError(payload && payload.ok === false ? payload.error || "配置错误" : null);
          })
          .catch(function (failure) { setError(String(failure && failure.message ? failure.message : failure)); })
          .finally(function () { setBusy(false); });
      }, [sessionQuery]);

      // 账号增删改：宿主负责改 config.json（加号时先把 key 写进凭证库），回传新快照。
      var postAccounts = useCallback(function (payload) {
        return fetch(ACCOUNTS_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...payload,
            ...(sessionId ? { session: String(sessionId) } : {}),
          }),
        })
          .then(function (response) {
            return response.json().then(function (json) { return { status: response.status, json: json }; });
          })
          .then(function (result) {
            if (result.status >= 400 || (result.json && result.json.ok === false)) {
              throw new Error(result.json && result.json.error ? result.json.error : "HTTP " + result.status);
            }
            setData(result.json);
            setError(null);
            return result.json;
          });
      }, [sessionId]);

      var onAccountAction = useCallback(function (action, payload) {
        postAccounts({ action: action, ...payload }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        });
      }, [postAccounts]);

      var submitAdd = useCallback(function () {
        var key = formKey.trim();
        if (formBusy || key === "") return;
        setFormBusy(true);
        postAccounts({ action: "add", label: formLabel.trim(), apiKey: key })
          .then(function () {
            setFormOpen(false);
            setFormLabel("");
            setFormKey("");
          })
          .catch(function (failure) {
            setError(String(failure && failure.message ? failure.message : failure));
          })
          .finally(function () { setFormBusy(false); });
      }, [postAccounts, formBusy, formKey, formLabel]);

      // 只在「当前会话用的就是本插件」时显示：选了别的提供商就让位，不占地方也不误导。
      var selection = useModelSelection(sessionId);
      var providerId = (data && data.provider && data.provider.id) || "opencode-go";
      var currentProvider = selection ? selection.provider : undefined;
      var reader = selectionReader(sessionId);
      reportDiag({
        session: sessionId ? String(sessionId).slice(0, 12) : null,
        dirs: modelDirectories !== null,
        sessions: sessionService !== null,
        source: reader ? reader.source : null,
        status: selection ? selection.status : null,
        current: currentProvider === undefined ? null : currentProvider,
        expected: providerId,
        shown: !(currentProvider !== undefined && currentProvider !== null && currentProvider !== providerId),
      });
      if (currentProvider !== undefined && currentProvider !== null && currentProvider !== providerId) return null;

      var accounts = (data && data.accounts) || [];
      // bound = 本会话真正钉住的号（没钉住时为 null）；pinned 只是「面板里高亮哪一行」的兜底。
      var bound = null;
      for (var index = 0; index < accounts.length; index += 1) {
        if (accounts[index].pinned) { bound = accounts[index]; break; }
      }
      var pinned = bound !== null ? bound : (accounts.length > 0 ? accounts[0] : null);

      // 胶囊显示「全池」月用量：启用账号的平均值（各号套餐上限相同，
      // 平均值就是整个池子用掉的比例）。会话钉住的单号用量在面板里各有自己一行。
      var poolSum = 0;
      var poolCount = 0;
      var enabledCount = 0;
      var exhaustedCount = 0;
      var breakdown = [];
      for (var poolIndex = 0; poolIndex < accounts.length; poolIndex += 1) {
        var poolAccount = accounts[poolIndex];
        if (poolAccount.enabled === false) continue;
        enabledCount += 1;
        if (poolAccount.exhausted === true) exhaustedCount += 1;
        var poolPercent = poolAccount.monthly && typeof poolAccount.monthly.percent === "number"
          ? poolAccount.monthly.percent
          : undefined;
        if (typeof poolPercent === "number" && isFinite(poolPercent)) {
          poolSum += poolPercent;
          poolCount += 1;
        }
        breakdown.push(poolAccount.label + " " + (typeof poolPercent === "number" ? fmt(poolPercent) + "%" : "—"));
      }
      var poolPercent = poolCount > 0 ? poolSum / poolCount : undefined;
      // 会话已绑定账号 → 胶囊显示**它**的月用量与颜色（用户看的是自己在用的那个套餐）；
      // 未绑定（新会话）→ 显示全池平均，作为「这一轮会用掉谁」的参考。
      var boundUsage = chipUsage(accounts, poolPercent);
      var percent = boundUsage.percent;
      var tone = toneOf(percent);
      // 只有「全池都打满」才算真的没额度；单号打满会在面板里标红并暂停参与选号。
      var exhausted = enabledCount > 0 && exhaustedCount === enabledCount;
      var poolText = poolPercent === undefined
        ? "全池暂无数据"
        : "全池平均 " + fmt(poolPercent) + "%（" + breakdown.join(" / ") + "）";
      var poolTitle = boundUsage.label !== ""
        ? "本会话账号 " + boundUsage.label + "：" + (boundUsage.percent === undefined ? "—" : fmt(boundUsage.percent) + "%") + "；" + poolText
        : "OpenCode Go 全池月用量 " + (poolPercent === undefined ? "—" : fmt(poolPercent) + "%") + "（" + breakdown.join(" / ") + "）";

      var chipStyle = {
        display: "inline-flex", alignItems: "center", gap: 5,
        height: 26, padding: "0 8px", borderRadius: 13,
        border: "1px solid " + (open ? tone : "var(--dsw-alias-border-l1, rgba(127,127,127,0.35))"),
        background: "transparent", color: "inherit", cursor: "pointer",
        fontSize: 11.5, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
        opacity: error && accounts.length === 0 ? 0.6 : 1,
      };

      // 「正在使用的模型」只做只读展示：模型选择统一走 DSH 自己的模型入口
      // （插件通过 listModels() 把所有 OpenCode Go 模型都注册进 DSH），面板里不再放下拉框。
      var models = (data && data.models) || [];
      var currentModelId = selection && selection.model ? selection.model : undefined;
      var currentModel = null;
      for (var modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        if (models[modelIndex].id === currentModelId) { currentModel = models[modelIndex]; break; }
      }
      var effortText = selection && selection.reasoningEffort ? selection.reasoningEffort : (currentModel && currentModel.defaultEffort) || "";

      var modelRow = h("div", {
        style: { display: "flex", alignItems: "center", gap: 6, padding: "0 2px 8px", fontSize: 11 },
      },
        h("span", { style: { opacity: 0.6, whiteSpace: "nowrap" } }, "当前模型"),
        h("span", { style: { fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          currentModel ? currentModel.name : (currentModelId || "未选择")),
        effortText && h("span", {
          style: { opacity: 0.55, whiteSpace: "nowrap" },
          title: "推理档位（在 DSH 的模型菜单里改）",
        }, "· " + effortText),
        pinned && h("span", {
          style: { opacity: 0.55, whiteSpace: "nowrap" },
          title: "本会话钉住的账号",
        }, "· " + pinned.label),
      );

      var panel = open && h("div", {
        ref: panelRef,
        style: {
          position: "fixed", left: anchor.left + "px",
          ...(anchor.top !== undefined ? { top: anchor.top + "px" } : { bottom: (anchor.bottom === undefined ? 8 : anchor.bottom) + "px" }),
          width: (anchor.width || PANEL_WIDTH) + "px",
          maxHeight: (anchor.maxHeight === undefined ? "62vh" : anchor.maxHeight + "px"), overflowY: "auto",
          background: "var(--dsw-alias-bg-l1, #1f1f22)", color: "var(--dsw-alias-fg-l1, #e6e6e6)",
          border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))",
          borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
          padding: 10, zIndex: 9999, fontSize: 12,
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "2px 2px 6px" } },
          h("div", { style: { display: "flex", flexDirection: "column", gap: 1 } },
            h("span", { style: { fontWeight: 650, fontSize: 12.5 } },
              (data && data.provider && data.provider.name ? data.provider.name : "OpenCode Go") + " 账号池"),
            h("span", { style: { fontSize: 10.5, opacity: 0.6 } },
              accounts.length + " 个账号 · 预留 " + (data && data.reserveDays !== undefined ? data.reserveDays : 3.5) + " 天 · 新会话自动选号"),
          ),
          h("div", { style: { display: "flex", gap: 6 } },
            h("button", {
              type: "button", onClick: onRefresh, disabled: busy,
              style: {
                height: 22, padding: "0 8px", borderRadius: 6, cursor: busy ? "default" : "pointer",
                border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))",
                background: "transparent", color: "inherit", fontSize: 11,
              },
            }, busy ? "刷新中…" : "刷新"),
            h("button", {
              type: "button",
              onClick: function () { setFormOpen(!formOpen); },
              title: formOpen ? "取消添加" : "添加账号",
              style: {
                height: 22, width: 22, borderRadius: 6, cursor: "pointer",
                border: "1px solid " + (formOpen ? "#4f8cff" : "var(--dsw-alias-border-l1, rgba(127,127,127,0.35))"),
                background: "transparent", color: "inherit", fontSize: 12, lineHeight: "18px",
              },
            }, formOpen ? "×" : "＋"),
            h("button", {
              type: "button", onClick: function () { setOpen(false); },
              style: {
                height: 22, width: 22, borderRadius: 6, cursor: "pointer",
                border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))",
                background: "transparent", color: "inherit", fontSize: 12, lineHeight: "18px",
              },
            }, "×"),
          ),
        ),

        error && h("div", {
          style: { fontSize: 11, color: "#e5484d", padding: "4px 6px 8px", lineHeight: 1.5 },
        }, error),

        modelRow,

        // 添加账号的内联表单（key 直接写进凭证库，不落 config.json 明文）
        formOpen && h("div", {
          style: {
            display: "flex", flexDirection: "column", gap: 6,
            padding: "8px 8px 10px", marginBottom: 6, borderRadius: 8,
            background: "var(--dsw-alias-bg-l2, rgba(255,255,255,0.05))",
            border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))",
          },
        },
          h("input", {
            value: formLabel,
            placeholder: "名称（可留空，默认 Go N）",
            onChange: function (event) { setFormLabel(event.target.value); },
            style: {
              height: 24, borderRadius: 6, padding: "0 6px", fontSize: 11.5,
              background: "transparent", color: "inherit",
              border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))",
            },
          }),
          h("div", { style: { display: "flex", gap: 6 } },
            h("input", {
              type: "password",
              value: formKey,
              placeholder: "OpenCode Go API key（oc_sk_…）",
              onChange: function (event) { setFormKey(event.target.value); },
              onKeyDown: function (event) { if (event.key === "Enter") submitAdd(); },
              style: {
                flex: "1 1 auto", minWidth: 0, height: 24, borderRadius: 6, padding: "0 6px", fontSize: 11.5,
                background: "transparent", color: "inherit",
                border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))",
              },
            }),
            h("button", {
              type: "button",
              onClick: submitAdd,
              disabled: formBusy || formKey.trim() === "",
              style: {
                height: 24, padding: "0 10px", borderRadius: 6, fontSize: 11.5,
                cursor: formBusy || formKey.trim() === "" ? "default" : "pointer",
                opacity: formBusy || formKey.trim() === "" ? 0.5 : 1,
                border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))",
                background: "rgba(79,140,255,0.18)", color: "inherit",
              },
            }, formBusy ? "添加中…" : "添加"),
          ),
          h("span", { style: { fontSize: 10, opacity: 0.55, lineHeight: 1.5 } },
            "key 存进 ~/.dsh/.credentials.yaml（refs），config.json 只记引用；加完立即参与选号。"),
        ),

        accounts.length === 0 && h("div", { style: { fontSize: 11.5, opacity: 0.7, padding: "8px 6px", lineHeight: 1.6 } },
          "还没有账号。点右上角「＋」添加，或在 ~/.dsh/opencode-go-pool/config.json 的 accounts 里手写条目。"),

        accounts.map(function (account) {
          return h(AccountRow, {
            key: account.id,
            account: account,
            reserveDays: data && data.reserveDays !== undefined ? data.reserveDays : 3.5,
            onAction: onAccountAction,
          });
        }),

        h("div", {
          style: { marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))", fontSize: 10.5, opacity: 0.6, lineHeight: 1.6 },
        },
          "评分 =（100 − 月用量%）/ max(距重置天数 − 预留天数, 0)：越闲且越接近重置越优先。会话内固定一个号，额度耗尽自动换号。",
          h("br"),
          "数据源：GET https://opencode.ai/zen/go/v1/usage（用 API key 直读，不需要 cookie）。",
          h("br"),
          "增删账号：~/.dsh/opencode-go-pool/config.json 的 accounts 里加/删条目，保存 1 秒生效；"
            + "条目加 \"enabled\": false 可停用但不删历史。凭据写 ~/.dsh/.credentials.yaml 的 refs。",
        ),
      );

      // 挂到 body 的 portal：脱离输入框槽位的祖先（可能有 transform/filter/overflow），
      // position:fixed 才是相对视口定位。拿不到 react-dom 时退回原位渲染（下面的兜底校正仍生效）。
      var mountedPanel = panel && createPortal && typeof document !== "undefined" && document.body
        ? createPortal(panel, document.body)
        : panel;

      return h(React.Fragment, null,
        h("button", {
          ref: buttonRef, type: "button", onClick: onOpen,
          title: error ? "OpenCode Go 账号池（" + error + "）" : poolTitle,
          "aria-label": "OpenCode Go 账号池用量", "aria-expanded": open ? "true" : "false",
          style: chipStyle,
        },
          h("span", { style: { width: 6, height: 6, borderRadius: 3, background: tone, display: "inline-block" } }),
          h("span", null, percent === undefined
            ? "Go"
            : ((boundUsage.label !== "" ? boundUsage.label + " " : "") + fmt(percent) + "%")),
          exhausted && h("span", { style: { opacity: 0.7 } }, "!"),
        ),
        mountedPanel,
      );
    }

    /** 需要 slots 服务（runtme 提供），locale 不依赖（文案直接内联中文）。 */
    var inject = ["slots"];

    /**
     * 抓一个可选服务：先同步 ctx.get，拿不到再用 ctx.inject 等它就绪。
     * 都拿不到就静默放弃（显隐退化为常显，绝不因此报错）。
     * @param {object} ctx - 客户端插件上下文。
     * @param {string} name - 服务名。
     * @param {(value: object) => void} assign - 拿到后的赋值回调。
     */
    function captureService(ctx, name, assign) {
      if (typeof ctx.get === "function") {
        try {
          var value = ctx.get(name);
          if (value) { assign(value); return; }
        } catch (error) { /* 未就绪或该版本无此服务 */ }
      }
      if (typeof ctx.inject === "function") {
        try {
          ctx.inject([name], function (scope) {
            var resolved;
            try {
              resolved = scope[name] || (typeof scope.get === "function" ? scope.get(name) : undefined);
            } catch (error) { resolved = undefined; }
            if (resolved) assign(resolved);
          });
        } catch (error) { /* 该服务不存在 */ }
      }
    }

    function apply(ctx) {
      // 模型选择的两条信号源：modelDirectories（首选）、sessions（备用）。
      // 拿到就能按「当前会话的提供商」决定显不显示；拿不到退化为常显。
      captureService(ctx, "modelDirectories", function (value) { modelDirectories = value; });
      captureService(ctx, "sessions", function (value) { sessionService = value; });
      ctx.slots.inject("conversation.input.right", function () {
        return ctx.slots.register({
          name: "conversation.input.right",
          id: "opencode-go-pool",
          order: 30,
        }, UsageChip);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = "opencode-go-pool";
    exports.UsageChip = UsageChip;
    // 供单测直接验证胶囊取值规则（浏览器端不使用）。
    exports.__chipUsage = chipUsage;
    return module.exports;
  },
});
