/* Markdown 渲染器（零依赖，先转义再解析，杜绝 XSS）
 *
 * 安全模型：输入先整体 HTML 转义，之后只生成我们自己可控的标签，
 * 因此任何 <script>、onerror=、javascript: 都不会被还原成可执行内容。
 * 不使用 innerHTML 拼接原始输入。
 */
const MD = (() => {
  "use strict";

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 代码块占位符，避免内部内容被后续行内规则改写
  const PLACEHOLDER = "\u0000CODE";

  function renderCode(rawCode, lang) {
    // rawCode 是未转义的原文，转义仅在此处发生一次
    const safe = escapeHtml(rawCode);
    const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : "";
    return `<div class="code-wrap">${label}`
      + `<button class="code-copy" type="button" data-copy="${safe.replace(/"/g, "&quot;")}">复制</button>`
      + `<pre><code>${safe}</code></pre></div>`;
  }

  /* ---------- 行内规则 ---------- */
  /** 输入为「未转义原文」，输出安全 HTML。转义只在这里发生一次。 */
  function inline(rawText) {
    // 先整体转义，再解析 markdown 语法（语法字符如 * ` [ 不受影响）
    let s = escapeHtml(rawText);

    // 行内代码 `code` —— 先抽出，避免内部 markdown 被解析
    // 此时 s 已转义，反引号仍是反引号，可正常匹配
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);          // c 已是转义后的文本
      return `\u0001${codes.length - 1}\u0001`;
    });

    // 图片 ![alt](url) —— 仅允许 http(s) 与 data:image
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      if (!/^(https?:\/\/|data:image\/)/i.test(url)) return m;
      return `<img class="md-img" src="${escapeHtml(url)}" alt="${alt}" loading="lazy">`;
    });

    // 链接 [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      if (!/^(https?:\/\/|mailto:|\/|#)/i.test(url)) return label;
      const ext = /^(https?:|mailto:)/i.test(url)
        ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${escapeHtml(url)}"${ext}>${label}</a>`;
    });

    // 自动链接裸 URL（跳过已有 href 内部）
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)"]+)/g,
      (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

    // 粗体 / 斜体 / 删除线
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    // 还原行内代码（内容已是转义后的文本，不可二次转义）
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${codes[+i]}</code>`);

    return s;
  }

  /* ---------- 块级规则 ---------- */
  function renderBlocks(src) {
    const lines = src.split("\n");
    const out = [];
    let i = 0;

    const flushParagraph = (buf) => {
      if (!buf.length) return;
      out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
      buf.length = 0;
    };
    const para = [];

    while (i < lines.length) {
      const line = lines[i];

      // 代码块 ```
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
      if (fence) {
        flushParagraph(para);
        const mark = fence[1];
        const lang = fence[2] || "";
        const body = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${mark[0] === "`" ? "```" : "~~~"}`).test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // 跳过结束围栏
        out.push(renderCode(body.join("\n"), lang));
        continue;
      }

      // 空行 → 段落分隔
      if (!line.trim()) {
        flushParagraph(para);
        i++;
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushParagraph(para);
        const lv = h[1].length;
        out.push(`<h${lv} class="md-h">${inline(h[2])}</h${lv}>`);
        i++;
        continue;
      }

      // 分隔线：整行只能是 3+ 个同类符号（不含其他字符）
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushParagraph(para);
        out.push("<hr>");
        i++;
        continue;
      }

      // 引用 >
      if (/^\s*>\s?/.test(line)) {
        flushParagraph(para);
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${renderBlocks(quote.join("\n"))}</blockquote>`);
        continue;
      }

      // 任务列表（必须先于普通无序列表判断）
      if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
        flushParagraph(para);
        const items = [];
        while (i < lines.length) {
          const t = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
          if (!t) break;
          const checked = t[1].toLowerCase() === "x";
          items.push(`<li class="task ${checked ? "done" : ""}">`
            + `<span class="box">${checked ? "✓" : ""}</span>${inline(t[2])}</li>`);
          i++;
        }
        out.push(`<ul class="tasklist">${items.join("")}</ul>`);
        continue;
      }

      // 无序列表
      if (/^\s*[-*+]\s+/.test(line)) {
        flushParagraph(para);
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
          i++;
        }
        out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
        continue;
      }

      // 有序列表
      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushParagraph(para);
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
          i++;
        }
        out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>`);
        continue;
      }

      // 表格（要求次行是分隔线）
      if (line.includes("|") && i + 1 < lines.length
          && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        flushParagraph(para);
        const splitRow = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
          .split("|").map((c) => c.trim());
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push('<div class="table-wrap"><table><thead><tr>'
          + head.map((c) => `<th>${inline(c)}</th>`).join("")
          + "</tr></thead><tbody>"
          + rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("")
          + "</tbody></table></div>");
        continue;
      }

      // 任务列表（已在上方优先匹配）
      para.push(line);
      i++;
    }
    flushParagraph(para);
    return out.join("");
  }

  /** 主入口：Markdown 文本 → 安全的 HTML 字符串 */
  function render(src) {
    if (src == null) return "";
    const text = String(src).replace(/\r\n?/g, "\n");
    // 块级解析在原文上进行（否则 > 会被转义成 &gt; 而无法识别引用），
    // 转义统一由 inline() / renderCode() 负责。
    return renderBlocks(text);
  }

  /** 复制代码按钮：事件委托，避免内联 on* 处理器 */
  function bindCopy(root) {
    root.addEventListener("click", async (e) => {
      const btn = e.target.closest(".code-copy");
      if (!btn) return;
      const code = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(code);
        const old = btn.textContent;
        btn.textContent = "已复制";
        setTimeout(() => (btn.textContent = old), 1200);
      } catch {
        btn.textContent = "复制失败";
      }
    });
  }

  return { render, bindCopy };
})();
