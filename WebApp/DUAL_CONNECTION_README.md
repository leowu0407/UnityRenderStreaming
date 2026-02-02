# 雙連線架構 (Dual Connection Architecture) - URLLC + eMBB

## 概述

此功能實現了Unity Render Streaming的雙連線架構，允許：
- **URLLC連線** (uesimtun1, 10.60.128.x): 低延遲，用於使用者傳送動作/輸入給伺服器
- **eMBB連線** (uesimtun0, 10.60.0.x): 高頻寬，用於伺服器傳送影片串流給使用者

## 架構圖

```
使用者端 (Client)                            伺服器端 (Server)
┌─────────────────┐                         ┌─────────────────┐
│                 │                         │                 │
│  ┌───────────┐  │   URLLC (輸入/動作)     │  ┌───────────┐  │
│  │uesimtun1  │──┼──────────────────────>──┼──│192.168.56 │  │
│  │10.60.128.x│  │   Port 81 (可設定)      │  │.115:81    │  │
│  └───────────┘  │                         │  └───────────┘  │
│                 │                         │                 │
│  ┌───────────┐  │   eMBB (影片串流)       │  ┌───────────┐  │
│  │uesimtun0  │<─┼──────────────────────<──┼──│192.168.56 │  │
│  │10.60.0.x  │  │   Port 80 (可設定)      │  │.114:80    │  │
│  └───────────┘  │                         │  └───────────┘  │
│                 │                         │                 │
└─────────────────┘                         └─────────────────┘
```

## 伺服器端設定

### 1. 設定雙IP位址

在伺服器上設定兩個IP位址：

```bash
# 假設使用 eth0 網卡
sudo ip addr add 192.168.56.114/24 dev eth0  # eMBB (影片)
sudo ip addr add 192.168.56.115/24 dev eth0  # URLLC (輸入)
```

或編輯 `/etc/netplan/` 下的設定檔（Ubuntu）：

```yaml
network:
  ethernets:
    eth0:
      addresses:
        - 192.168.56.114/24
        - 192.168.56.115/24
      routes:
        - to: default
          via: 192.168.56.1
  version: 2
```

套用設定：
```bash
sudo netplan apply
```

### 2. 編譯WebApp

```bash
cd /home/ubuntu/UnityRenderStreaming/WebApp
npm install
npm run build
```

### 3. 啟動雙模式伺服器

使用 `-d` 或 `--dual` 參數啟動雙連線模式：

```bash
# 基本雙模式啟動 (Port 80 為 eMBB, Port 81 為 URLLC)
npm run start -- -d

# 或指定不同的端口
npm run start -- -d --dual-port 8081 -p 8080

# 完整參數範例
npm run start -- --dual --port 80 --dual-port 81 --mode private
```

### 4. 啟動VR Server

```bash
# 編譯VR Server
xvfb-run --auto-servernum --server-args='-screen 0 640x480x24' \
  "/home/ubuntu/Unity/Hub/Editor/6000.3.2f1/Editor/Unity" \
  -batchmode -nographics -quit \
  -projectPath "/home/ubuntu/VR Server" \
  -buildLinux64Player "/home/ubuntu/VR Server/Build/MyServerApp.x86_64" \
  -logFile build.log

# 設定執行權限
chmod +x "/home/ubuntu/VR Server/Build/MyServerApp.x86_64"

# 執行VR Server
xvfb-run --auto-servernum --server-args='-screen 0 640x480x24' \
  "/home/ubuntu/VR Server/Build/MyServerApp.x86_64" \
  -screen-width 640 -screen-height 480 \
  -screen-quality Fastest -force-glcore
```

## 使用者端設定

### 1. 設定路由

在使用者端設定路由，讓兩條連線走不同的網卡：

```bash
# eMBB路由 (接收影片) - 使用 uesimtun0
sudo ip route add 192.168.56.114/32 dev uesimtun0

# URLLC路由 (傳送輸入) - 使用 uesimtun1
sudo ip route add 192.168.56.115/32 dev uesimtun1
```

### 2. 使用瀏覽器連接

開啟瀏覽器，訪問：
```
http://192.168.56.114/dual-interface/
```

在頁面上設定連線參數：
- **eMBB Server (Video)**: 192.168.56.114, Port: 80
- **URLLC Server (Input)**: 192.168.56.115, Port: 81

點擊「Connect」按鈕建立連線。

## 檔案結構

新增/修改的檔案：

```
WebApp/
├── src/
│   ├── index.ts                    # 已修改：支援 --dual 參數
│   ├── websocket.ts                # 已修改：支援雙連線模式
│   └── class/
│       ├── options.ts              # 已修改：新增 dual/dualPort 選項
│       └── websockethandler-dual.ts # 新增：雙連線處理邏輯
├── client/
│   ├── src/
│   │   └── dual-signaling.js       # 新增：雙WebSocket信令類別
│   └── public/
│       └── dual-interface/         # 新增：雙連線介面
│           ├── index.html
│           ├── css/
│           │   └── style.css
│           └── js/
│               ├── main.js
│               └── video-player-dual.js
```

## 運作原理

### 連線配對機制

1. 使用者端建立連線時會產生一個 `pairId` (UUID)
2. 使用者端同時建立兩條WebSocket連線（一條到eMBB伺服器，一條到URLLC伺服器）
3. 兩條連線都會發送 `register-dual` 訊息，包含相同的 `pairId` 和各自的 `channelType`
4. 伺服器端將這兩條連線配對在一起
5. 當配對完成後，伺服器會發送 `pair-complete` 通知

### 訊息路由

- **使用者輸入** (鍵盤、滑鼠、遊戲手把等):
  1. 使用者端透過URLLC WebSocket發送輸入事件
  2. 伺服器接收後處理並傳送給VR Server
  
- **影片串流**:
  1. VR Server透過WebRTC傳送影片
  2. 伺服器透過eMBB WebSocket發送信令
  3. 使用者端接收影片串流

## 疑難排解

### 連線問題

1. **檢查IP設定**
   ```bash
   ip addr show
   ```

2. **檢查路由設定**
   ```bash
   ip route show
   ```

3. **檢查端口是否開放**
   ```bash
   sudo netstat -tlnp | grep -E '80|81'
   ```

4. **檢查防火牆**
   ```bash
   sudo ufw status
   sudo ufw allow 80/tcp
   sudo ufw allow 81/tcp
   ```

### 日誌檢視

WebApp會輸出連線狀態日誌：
```bash
npm run start -- -d 2>&1 | tee webapp.log
```

在瀏覽器開發者工具中可以看到詳細的連線日誌。

## 進階設定

### 綁定特定IP

如果需要讓伺服器只綁定特定IP，可以修改 `index.ts` 中的 `listen` 呼叫。

### 使用HTTPS

```bash
npm run start -- -d -s -k server.key -c server.cert
```

### 自定義端口

```bash
# eMBB在8080, URLLC在8081
npm run start -- -d -p 8080 --dual-port 8081
```

## 效能考量

- URLLC連線應設定較低的緩衝區以降低延遲
- eMBB連線可以使用較大的緩衝區以支援高頻寬傳輸
- 建議在5G核心網路中正確設定QoS參數
