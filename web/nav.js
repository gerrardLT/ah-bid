/**
 * 全站统一导航。
 *
 * 为什么用 JS 注入而不是每页复制 HTML：
 *   之前是两套实现（新页顶部 nav + 旧页右下角浮动按钮），结果新页缺「数据」入口、
 *   旧页被浮层挡住，两边都跳不全。改一处全站生效，才不会再分叉。
 *
 * 两种形态：
 *   - 页面里已有 <nav>（日报/项目/自检）→ 就地重填，顶部条
 *   - 没有 <nav>（数据/招标人/模型/模拟，100vh 布局不能加头部）→ 右下角浮动按钮
 *
 * 合并规则：招标人画像 / 八维模型 / 决策模拟 都是「报价线」，收进「报价」下拉。
 */

(function () {
  const ITEMS = [
    { href: '/digest', label: '日报' },
    { href: '/project', label: '项目' },
    { href: '/check', label: '自检' },
    {
      label: '报价',
      children: [
        { href: '/buyers.html', label: '招标人画像' },
        { href: '/model.html', label: '八维模型' },
        { href: '/simulator.html', label: '决策模拟' },
      ],
    },
    { href: '/', label: '数据' },
  ];

  const path = location.pathname.replace(/\/$/, '') || '/';
  const isOn = (h) => {
    if (h === '/') return path === '/' || path === '/index.html';
    if (h === '/check') return path === '/check' || path === '/check.html';
    return path === h;
  };
  const groupOn = (item) => (item.children || []).some((c) => isOn(c.href));

  const CSS = `
.ahnav{display:flex;align-items:center;gap:2px;flex:1;overflow:visible}
.ahnav a,.ahnav summary{
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  color:#3B3630;text-decoration:none;padding:5px 10px;border-bottom:2px solid transparent;
  white-space:nowrap;cursor:pointer;list-style:none;
}
.ahnav summary::-webkit-details-marker{display:none}
.ahnav a:hover,.ahnav summary:hover{color:#C8371A}
.ahnav a.on{color:#C8371A;border-bottom-color:#C8371A;font-weight:600}
.ahnav details{position:relative}
.ahnav details[open] summary{color:#C8371A}
.ahnav details.on summary{color:#C8371A;border-bottom-color:#C8371A;font-weight:600}
.ahnav-menu{
  position:absolute;top:calc(100% + 4px);left:0;background:#fff;border:1px solid #D5D1C7;
  min-width:128px;z-index:300;box-shadow:0 6px 18px rgba(0,0,0,.08);
}
.ahnav-menu a{display:block;padding:7px 12px;border-bottom:1px solid #E9E6DF;border-left:0}
.ahnav-menu a:last-child{border-bottom:0}
.ahnav-menu a:hover{background:#FBFAF7}
/* 浮动形态（100vh 布局的旧页，不能插头部） */
#ahnFloat{position:fixed;right:14px;bottom:14px;z-index:99999;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
#ahnFloat .fbtn{padding:7px 13px;border:1px solid #D5D1C7;background:#fff;cursor:pointer;
  color:#3B3630;font:600 12.5px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
#ahnFloat .fmenu{display:none;position:absolute;right:0;bottom:100%;margin-bottom:6px;
  background:#fff;border:1px solid #D5D1C7;min-width:124px;box-shadow:0 6px 18px rgba(0,0,0,.08)}
#ahnFloat .fmenu a{display:block;padding:7px 12px;color:#3B3630;text-decoration:none;border-bottom:1px solid #E9E6DF}
#ahnFloat .fmenu a:last-child{border-bottom:0}
#ahnFloat .fmenu a:hover{background:#FBFAF7;color:#C8371A}
#ahnFloat .fmenu .fs{padding:6px 12px 3px;font-size:11px;color:#8A8378;background:#FBFAF7}
/* 极窄屏（<520px）：标题让位给导航，否则「数据」会被挤出可视区 */
@media (max-width:520px){
  header h1{display:none}
  .ahnav a,.ahnav summary{padding:5px 7px;font-size:12.5px}
}
`;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // 干掉旧页的浮动导航（改由本脚本接管，内容才一致）
  const old = document.getElementById('navx');
  if (old) old.remove();

  const navEl = document.querySelector('header nav, nav');

  if (navEl) {
    navEl.className = 'ahnav';
    navEl.innerHTML = ITEMS.map((it) => {
      if (it.children) {
        return `<details${groupOn(it) ? ' class="on"' : ''}>
          <summary>${it.label} ▾</summary>
          <div class="ahnav-menu">${it.children
            .map((c) => `<a href="${c.href}">${c.label}</a>`).join('')}</div>
        </details>`;
      }
      return `<a href="${it.href}"${isOn(it.href) ? ' class="on"' : ''}>${it.label}</a>`;
    }).join('');
  } else {
    // 100vh 布局的页面：插头部会把内容挤出视口，只能浮动
    const box = document.createElement('div');
    box.id = 'ahnFloat';
    const flat = ITEMS.flatMap((it) => (it.children ? [{ group: it.label }, ...it.children] : [it]));
    box.innerHTML = `<div class="fmenu">${flat
      .map((it) => (it.group
        ? `<div class="fs">${it.group}</div>`
        : `<a href="${it.href}"${isOn(it.href) ? ' style="color:#C8371A;font-weight:600"' : ''}>${it.label}</a>`))
      .join('')}</div>
      <button class="fbtn">导航</button>`;
    document.body.appendChild(box);
    const btn = box.querySelector('.fbtn');
    const menu = box.querySelector('.fmenu');
    btn.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    };
    document.addEventListener('click', (e) => {
      if (!box.contains(e.target)) menu.style.display = 'none';
    });
  }

  // 点开下拉后点空白处收起（details 原生不会自己关）
  document.addEventListener('click', (e) => {
    document.querySelectorAll('nav.ahnav details[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
})();
