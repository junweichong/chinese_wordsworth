# Chinese Wordsworth

Chinese Wordsworth 是一款实时多人汉字组词游戏。玩家在同一房间内轮流从公共字池选字，并将每轮选出的汉字放入各自的 6×6 棋盘，尝试在横向或纵向组成词语。每局支持 2 至 50 名玩家。

## 游戏规则

1. 房主创建房间，其他玩家使用房间代码加入。房间至少需要 2 名参赛玩家；房主也可以选择以观战模式开始。
2. 房主开始游戏时可设置每回合的思考时间、是否启用自动计分，以及终局寻词时长；也可以关闭回合倒计时。
3. 游戏进行 35 个共享选字回合。轮到的玩家从 20 格公共字池中选一个汉字，其他参赛玩家也会将这个字放进自己的棋盘。字池包含 12 个常见字、6 个较少见字和 2 个稀有字；选中的格子会补入新字，字池每 5 回合刷新一次。
4. 35 个回合结束后，每位玩家自行输入一个汉字，填满自己棋盘上的第 36 格。
5. 终局按横向或纵向连续组成的 3 至 6 字词语计分。游戏使用内置词典验证词语；根据房主的设置，系统可自动计算棋盘得分，或由玩家在限时寻词阶段逐个确认词语。

## 计分规则

| 词语长度 | 得分 |
| --- | ---: |
| 3 字 | 3 分 |
| 4 字 | 8 分 |
| 5 字 | 12 分 |
| 6 字 | 20 分 |

结算时按总分排名，得分最高的玩家获胜。

## 技术栈

- 后端：Node.js、Express、Socket.IO
- 前端：原生 HTML、CSS 和 JavaScript
- 数据存储：SQLite（better-sqlite3）或 PostgreSQL
- 部署：Docker、Render

## 本地运行

需要 Node.js 22 或更高版本。

```bash
npm install
npm start
```

启动后访问 <http://localhost:3000>。开发时可用以下命令启用自动重启：

```bash
npm run dev
```

本地开发环境未设置 `ADMIN_PASSWORD` 时，管理后台默认密码为 `admin123`；管理页面位于 `/admin`。请勿在公开部署中使用默认密码。

## 部署到 Render

在 Render 中连接 GitHub 仓库并创建 **Web Service**，配置如下：

- Branch：`main`
- Runtime：Docker
- Root Directory：留空
- Dockerfile Path：`./Dockerfile`
- Health Check Path：`/`
- Auto-Deploy：提交代码时自动部署

在 Render 服务的 **Environment** 中设置 `ADMIN_PASSWORD`，并在保存后重新部署。生产环境未设置此变量时，服务会停止启动。不要将本地 `.env` 文件提交到仓库；Render 不会读取本地环境文件。

Render 会根据 `Dockerfile` 构建镜像并运行 `npm start`。之后推送到 `main` 分支的提交会触发自动部署。