/* 简化层叠模拟：验证带 hidden 的元素在存在类 display 声明时仍被隐藏 */
const fs = require("fs");
const css = fs.readFileSync(require("path").join(__dirname,"..","static","style.css"), "utf8");
const html = fs.readFileSync(require("path").join(__dirname,"..","frontend","index.html"), "utf8");

// 提取所有 .cls { display: X } 的类
const classDisplay = {};
for (const m of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
  const d = m[2].match(/display\s*:\s*([^;!]+)/);
  if (d) classDisplay[m[1]] = d[1].trim();
}

// 全局规则是否存在
const globalHidden = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css);

// 找出 HTML 里带 hidden 的元素及其类
const results = [];
for (const m of html.matchAll(/<(\w+)([^>]*\bhidden\b[^>]*)>/g)) {
  const attrs = m[2];
  const idm = attrs.match(/id="([\w-]+)"/);
  const clm = attrs.match(/class="([^"]*)"/);
  const classes = clm ? clm[1].split(/\s+/).filter(Boolean) : [];
  const conflicting = classes.filter(c => classDisplay[c]);
  results.push({
    id: idm ? idm[1] : "(no id)",
    conflicts: conflicting.map(c => `${c}:display=${classDisplay[c]}`),
    hiddenByGlobal: globalHidden,
  });
}

console.log(`全局 [hidden] !important 规则: ${globalHidden ? "存在 ✓" : "缺失 ✗"}\n`);
console.log("带 hidden 属性的元素:");
let bad = 0;
for (const r of results) {
  let status;
  if (!r.conflicts.length) {
    status = "OK（类无 display，UA 默认即可隐藏）";
  } else if (r.hiddenByGlobal) {
    status = "OK（全局 !important 兜底）　冲突: " + r.conflicts.join(", ");
  } else {
    status = "!!! 会被类声明覆盖并显示 !!! 冲突: " + r.conflicts.join(", ");
    bad++;
  }
  console.log(`  ${r.id.padEnd(20)} ${status}`);
}
console.log(bad ? `\n✗ ${bad} 个元素可能意外显示` : "\n✓ 全部安全");
process.exit(bad ? 1 : 0);
