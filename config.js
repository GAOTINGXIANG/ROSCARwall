/**
 * 留言墙配置
 * 只需改 owner 与 repo 两项；其余保持默认即可。
 */
window.WALL_CONFIG = {
  // 你的 GitHub 用户名（或组织名）
  owner: 'your-github-name',
  // 存放留言 Issue 的仓库名
  repo: 'ROSCARwall',
  // 可选：只显示带该标签的 Issue（例如 'wall'）。留空表示显示仓库全部 Issue
  label: '',
  // 自动刷新间隔（毫秒）。未认证接口限 60 次/小时/IP，不建议小于 90000
  pollMs: 90000,
  // 一次最多展示的留言条数（GitHub 上限 100）
  pageSize: 50
};
