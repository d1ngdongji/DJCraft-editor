# DJCraft 曲目包功能文档

> 代码基线：Minecraft 1.21.1、NeoForge 21.1.218；文档核对日期：2026-07-22。  
> 状态标记：**已完成**表示当前代码存在可达实现；**部分完成**表示主流程存在但有限制或未贯通；**未完成**表示数据结构或入口已经预留，但没有实际消费逻辑。

相关文档：[文档索引](README.md) · [资源包](resource-pack.md) · [数据包](data-pack.md) · [附属 Mod 接口](addon-api.md)

## 1. 功能概述

曲目包（TrackPack）是 DJCraft 的内容与节奏规则载体。一个曲目包同时描述：

- 音频文件及曲目元信息；
- 战斗节拍时间线和每类节拍的判定参数；
- 准星预览方式和播放音量；
- 可选唱片、完美唱片和连击数字贴图；
- 客户端与服务端用于一致性校验的定义哈希。

曲目包被加载后，会参与动态声音资源注册、DJ 唱片刻录、便携点唱机播放、DJ 会话时钟、战斗判定、准星渲染、节拍类别伤害规则、唱片统计和服务端向客户端下载等流程。

## 2. 支持的封装形式

曲目包存放目录为：

```text
<游戏目录>/djcraft/trackpacks/
```

### 2.1 目录曲目包

```text
djcraft/trackpacks/example_track/
├─ track.json                 # 必需
├─ track.ogg                  # 必需；实际名称由 meta.sound_file 指定
├─ disc.png                   # 可选，普通唱片贴图
├─ disc.jpg                   # 可选，仅播放器 UI 可作为普通封面后备
├─ perfect_disc.png           # 可选，镀金/完美唱片贴图
└─ combo/
   ├─ 0.png ... 9.png         # 可选，从 1 连击生效的兼容格式
   ├─ 20/0.png ... 20/9.png   # 可选，从 20 连击生效
   └─ 50/0.png ... 50/9.png   # 可选，可配置多个阈值
```

目录名经小写转换后成为 `packId`。

### 2.2 `.djcraft` 压缩曲目包

`.djcraft` 实际为 ZIP 文件，文件名去掉扩展名并转为小写后成为 `packId`：

```text
djcraft/trackpacks/example_track.djcraft
└─ ZIP 根目录
   ├─ track.json
   ├─ track.ogg
   ├─ disc.png
   ├─ perfect_disc.png
   ├─ combo/0.png ... combo/9.png
   └─ combo/<threshold>/0.png ... 9.png
```

`track.json` 必须位于压缩包根目录，不能再套一层文件夹。服务端下载功能只分发 `.djcraft` 文件，目录曲目包不能被客户端下载。

### 2.3 ID 规则

当前加载器拒绝空 ID、`.`、`..`、长度超过 128 的 ID，以及包含控制字符、`/`、`\`、`:` 的 ID。

建议作者进一步只使用 Minecraft 资源路径安全字符：

```text
[a-z0-9._-]
```

这是因为曲目 ID 还会用于声音事件、模型和贴图资源路径。当前校验器并未禁止空格等资源路径非法字符，详见“未完成与已知限制”。

## 3. `track.json` 格式

### 3.1 完整示例

```json
{
  "meta": {
    "version": "1.0",
    "author": "DJCraft Team",
    "bpm": 128,
    "difficulty": "normal",
    "sound_file": "track.ogg",
    "offset_ms": 0,
    "playback_start_ms": 0,
    "total_duration_ms": 180000,
    "display_name": "Example Track"
  },
  "settings": {
    "crosshair_mode": "time",
    "crosshair_time_ms": 1400,
    "crosshair_beat_count": 4,
    "volume_multiplier": 1.0
  },
  "definitions": {
    "normal_hit": {
      "can_attack": true,
      "color": "#FFFFFF",
      "scale": 1.0,
      "category": "weakbeat",
      "haptic_intensity": 1.0,
      "tolerance": 0.1,
      "particle": null,
      "trigger": null
    },
    "strong_hit": {
      "can_attack": true,
      "color": "#FFAA00",
      "scale": 1.2,
      "category": "downbeat",
      "haptic_intensity": 1.0,
      "tolerance": 80.0
    }
  },
  "timeline": {
    "combat_line": [
      { "t": 1000, "type": "normal_hit" },
      { "t": 1469, "type": "strong_hit", "props": { "label": "drop" } }
    ],
    "lighting": [
      { "t": 1000, "type": "flash" }
    ]
  }
}
```

时间轴事件在加载时会按 `t` 从小到大排序。

### 3.2 `meta` 字段

| 字段 | 类型 | `createDefault()` 值 | 当前用途 | 状态 |
|---|---:|---|---|---|
| `version` | string | `"1.0"` | 格式版本预留 | **未完成：已解析但不校验、不参与兼容性判断** |
| `author` | string | `"Unknown"` | 播放器和刻录 UI 显示 | **已完成** |
| `bpm` | integer | `120` | UI、命令和日志显示 | **部分完成：播放与判定直接使用毫秒时间线，BPM 不生成节拍** |
| `difficulty` | string | `"normal"` | 摘要信息 | **未完成：游戏 UI 和规则未使用** |
| `sound_file` | string | `"track.ogg"` | 定位 OGG 音频 | **已完成** |
| `offset_ms` | integer | `0` | 从 DJ 会话原始时间中扣除，整体校准判定时间线 | **已完成** |
| `playback_start_ms` | integer | `0` | 音频与服务端会话时钟从该毫秒位置开始；开始位置之前的节拍不会补触发 | **已完成** |
| `total_duration_ms` | integer | `180000` | 会话时长/统计上限等 | **已完成** |
| `display_name` | string/null | 回退为 `packId` | 唱片名称和 UI 标题 | **已完成** |

注意：上表第三列是 `TrackMeta.createDefault()` 的辅助对象取值，不是 JSON 解析器的逐字段默认值。加载器不会在缺失 `meta` 或字段时主动套用该对象；未填写 `playback_start_ms` 时 Gson 的整数零值使其从头播放，负值也按 `0` 处理；`sound_file` 另有 `track.ogg` 运行时回退。作者应始终提供完整 `meta`。

### 3.3 `settings` 字段

`settings` 整体可省略；省略时使用默认值。

| 字段 | 类型 | 默认值 | 当前用途 | 状态 |
|---|---:|---:|---|---|
| `crosshair_mode` | string | `"time"` | `time` 按未来毫秒范围显示；值恰为 `beat` 时按未来节拍数显示 | **已完成** |
| `crosshair_time_ms` | integer | `1400` | `time` 模式准星预览窗口 | **已完成** |
| `crosshair_beat_count` | integer | `4` | `beat` 模式未来节拍数量 | **已完成** |
| `volume_multiplier` | number | `1.0` | 播放音量倍数 | **已完成** |

当前没有范围校验。负值、零、极大数值或未知的 `crosshair_mode` 不会在加载阶段被拒绝；未知模式按 `time` 行为处理。

### 3.4 `definitions` 字段

`definitions` 是“节拍类型名 → 节拍定义”的对象。`combat_line[*].type` 引用其中的键。引用不存在时，判定器使用默认定义，而不是拒绝曲目包。

| 字段 | 类型 | 默认值 | 当前用途 | 状态 |
|---|---:|---:|---|---|
| `can_attack` | boolean | `true` | 为 `false` 时该节拍不能判定为命中，也不计入未命中连击重置的节拍数 | **已完成** |
| `color` | string | `#FFFFFF` | 准星节拍颜色 | **已完成** |
| `scale` | number | `1.0` | 视觉缩放预留 | **未完成：没有运行时代码读取** |
| `category` | string | `"normal"` | 战斗类别：`normal`、`weakbeat` 或 `downbeat` | **已完成** |
| `haptic_intensity` | number | `1.0` | 震动强度预留 | **未完成：没有运行时代码读取** |
| `tolerance` | number | `0.1` | 判定容差 | **已完成** |
| `particle` | string/null | `null` | 粒子资源预留 | **未完成：只提供 `hasParticle()`，没有触发逻辑** |
| `trigger` | string/null | `null` | 条件触发预留 | **未完成：只提供 `hasTrigger()`，没有条件解析/执行逻辑** |

`tolerance` 的实际语义：

- `tolerance > 1.0`：直接解释为毫秒数；例如 `80.0` 表示 ±80 ms。
- `tolerance <= 1.0`：解释为相邻节拍间隔的比例；例如相邻间隔 500 ms、容差 `0.1`，判定窗口为 ±50 ms。
- 首尾孤立节拍无法取得相邻间隔时，基准间隔为 500 ms。

### 3.5 `timeline` 字段

| 字段 | 类型 | 说明 | 状态 |
|---|---|---|---|
| `combat_line` | array | 战斗判定主轨；每项含 `t`、`type`、可选 `props` | **已完成** |
| 其他任意键 | array | 被保存为命名特效轨，如示例中的 `lighting` | **未完成：已解析、可查询和计数，但没有运行时调度/消费器** |

事件字段：

| 字段 | 类型 | 默认值 | 状态 |
|---|---:|---|---|
| `t` | integer | `0` | **已完成**；单位为毫秒 |
| `type` | string | `"normal_hit"` | **已完成**；引用 `definitions` |
| `props` | object | 空对象 | **未完成：原始标量值会被解析并保留，但生产代码没有读取任何事件覆盖属性** |

`props` 当前只保留 number、boolean、string；数组、对象和 null 会被忽略。所有 number 会解析为 `Double`。

## 4. 可选资源

### 4.1 音频

- 音频通过动态生成的 `djcraft:sounds.json` 注册为 `djcraft:trackpacks.<packId>`。
- 资源层实际暴露路径为 `assets/djcraft/sounds/trackpacks/<packId>.ogg`。
- `sound_file` 可以改变包内源文件名，但对外动态声音事件仍按 `packId` 稳定命名。
- 当前实现面向 OGG；不会对扩展名、编码格式、声道或采样率做预检，解码失败会在播放阶段暴露。

### 4.2 唱片贴图

- `disc.png`：普通唱片物品模型和播放器封面。
- `disc.jpg`：只作为播放器普通封面后备；不会生成物品模型资源。
- `perfect_disc.png`：镀金唱片物品模型和播放器封面。
- 未提供自定义贴图时使用 DJCraft 内置普通/镀金唱片贴图。

动态物品模型按已加载曲目包 ID 排序后分配 `djcraft:pack_index`。唱片达到镀金条件后，`djcraft:gilded` 属性切换为完美唱片模型。

镀金条件为：

```text
最大连击 >= ceil(战斗节拍总数 × 80%)
```

且战斗节拍总数必须大于 0。

### 4.3 连击数字贴图

曲目包可以提供多阶段连击数字贴图：

- `combo/0.png` 至 `combo/9.png` 是兼容格式，从 1 连击开始生效；
- `combo/<threshold>/0.png` 至 `9.png` 从指定连击数开始生效，并允许配置多个阈值；
- 阈值目录必须是无前导零的十进制整数，范围为 `2..2147483647`；`combo/1/` 不支持，因为根目录兼容格式已经表示该阶段。

渲染时选择不超过当前连击数的最大阈值。每个阶段允许只提供部分数字：缺失、无法解码或完全透明的图片继承上一阶段的同一数字，根阶段则回退内置基础数字。有效图片的动态资源 ID 为：

```text
djcraft:textures/gui/combo/trackpacks/<packKey>/<digit>.png
djcraft:textures/gui/combo/trackpacks/<packKey>/<threshold>/<digit>.png
```

`packKey` 是由 `packId` 稳定派生的 UUID，用于保证 Minecraft 资源路径合法。没有成功加载任何自定义数字贴图的曲目使用内置阶段：1–49 连击使用基础数字，`>=50` 使用高连击数字。只要任意一张曲目包数字贴图成功加载，该曲目就完全禁用内置 `>=50` 阶段，由曲目包阶段和逐数字继承规则决定最终贴图。非法阈值会记录警告但不会阻止曲目包加载。

## 5. 加载、重载与优先级

### 5.1 启动加载

模组初始化时创建曲目包目录并扫描内容。扫描顺序为：

1. 文件名排序后的全部 `.djcraft`；
2. 路径排序后的全部目录包。

同一 `packId` 冲突时，后加载来源覆盖先加载来源，因此目录包会覆盖同名 `.djcraft` 包，并记录警告。

### 5.2 哈希

系统维护两种 SHA-256：

- 定义哈希：只计算原始 `track.json`，用于服务端/客户端一致性列表；
- 归档哈希：计算整个 `.djcraft` 文件，用于客户端下载完成后的完整性校验。

因此，双端拥有相同 `track.json` 但音频或贴图不同，仍会被判定为“定义一致”。

### 5.3 重载入口

- `/dj reload`：服务端重载，要求权限等级 2；随后向在线玩家重新同步哈希。
- DJ 刻录 UI 的“重载曲包”：客户端本地重扫并刷新 Minecraft 资源包。
- 下载完成：客户端校验、安装单包、重新计算验证集合并刷新资源包。
- `ReloadTracksPayload`：客户端网络处理器可触发本地全量重载。

资源刷新是异步的；解析后的曲目注册表先更新，动态声音/模型/贴图在资源刷新成功后可见。

## 6. 多人同步与下载

### 6.1 双端定义校验

玩家登录服务端时，服务端下发全部 `packId → track.json SHA-256`。客户端与本地定义哈希取交集，生成 `verifiedPackIds`。

结果含义：

- ID 和哈希均一致：verified；
- 服务端有、本地没有：缺失；
- ID 相同但哈希不同：版本不一致；
- 仅客户端本地存在：不会进入服务端列表。

### 6.2 下载命令

```text
/djclient download <trackpack>
```

该客户端命令只允许请求服务端已公布且尚未 verified 的曲目。服务端必须持有对应 `.djcraft` 源文件；如果服务端加载的是目录包，返回 `NOT_FOUND`。

### 6.3 传输协议

下载流程为：

1. 客户端发送下载请求；
2. 服务端检查 ID、并发状态、归档存在性和大小；
3. 服务端发送 transfer ID、总大小、归档 SHA-256；
4. 服务端按最大 256 KiB 的块发送，每个窗口最多 4 块；
5. 客户端按连续 offset 写入临时 `.part` 文件，并对窗口 ACK；
6. 下载完毕后客户端校验归档 SHA-256；
7. 临时文件原子移动为 `<packId>.djcraft`（不支持原子移动时普通替换）；
8. 客户端执行安全校验、单包加载、资源刷新，最后 ACK 完成。

默认压缩与解压总量上限为 256 MiB，可由 `maxTrackPackDownloadMiB` 配置，允许范围 1–2048 MiB。失败原因包括：不存在、过大、忙、IO 错误、哈希不一致、超时、重载失败和无效请求。

## 7. 唱片刻录与存储

### 7.1 空白唱片

物品 `djcraft:empty_disc` 堆叠上限为 1。空白唱片可由配方获得，并在 DJ 刻录台 UI 中选择曲目。

服务端接受刻录请求前会校验：

- 目标方块确实是 DJ 刻录台；
- 玩家距方块不超过 8 格；
- 指定手持物是尚无 `track_pack_id` 的空白唱片；
- 服务端已加载目标曲目包。

成功后原物品写入：

- `djcraft:track_pack_id`：曲目 ID；
- `djcraft:disc_id`：新生成的唱片 UUID；
- `djcraft:disc_statistics`：初始最大连击 0、累计播放 0 ms。

### 7.2 便携点唱机

便携点唱机使用原版 `CONTAINER` 数据组件持久化 54 个槽位：

- Shift + 右键：打开 9×6 存储界面；
- 普通右键：打开 ModernUI 播放器；
- `G` 热键也可打开播放器（以当前客户端按键逻辑为准）。

播放器按点唱机槽位顺序构造轮播与播放列表。只有能在客户端本地注册表中解析到曲目包的唱片会显示。

**部分完成：** 当前容器只检查物品类型为 `empty_disc`，没有检查 `track_pack_id`，所以空白唱片也能放入；这与项目规则“仅接受已加载曲目包的唱片”不一致。

## 8. 播放与 DJ 会话

播放器发送“物理唱片引用”，包含曲目 ID、唱片 UUID、点唱机所在玩家背包槽位和唱片槽位。服务端会重新查找并验证唱片，避免客户端伪造任意曲目播放。

播放流程：

1. 客户端播放器选择唱片并提交播放请求；
2. 服务端确认自己已加载曲目，并确认玩家确实持有匹配的点唱机唱片；
3. 服务端创建 `DJSession`，下发 session ID、曲目 ID、唱片 UUID；
4. 客户端加载本地曲目，并从 `playback_start_ms`（或多人组播追赶到的更晚位置）启动 OpenAL 音频；
5. 客户端报告实际播放就绪时间，服务端同步会话时钟；
6. 服务端与客户端会话使用同一播放位置，并以 `播放时间 - offset_ms` 作为虚拟时间线时间；开始位置之前的节拍视为已经过，不会集中补触发；
7. 自然结束、手动停止或切歌后持久化唱片统计；
8. 播放列表可按顺序、单曲循环或列表循环模式推进。

管理员还可使用：

```text
/dj play <trackpack>
/dj play <targets> <trackpack>
/dj stop
/dj stop <targets>
/dj list
/dj set combo <targets> <value>
/dj set energy <targets> <value>
/dj reload
```

`play`、`stop`、`set`、`reload` 要求权限等级 2；`list` 无该限制。管理员播放不要求物理唱片，因此不会关联唱片 UUID/统计。

`/dj set combo` 和 `/dj set energy` 只修改目标玩家当前正在进行的 DJ 会话。连击数必须是非负整数；能量必须是非负数，并按每名玩家当前的 `djcraft:max_energy` 上限截断。修改后服务端会立即同步客户端 HUD；设置的连击也会计入本次会话最大连击。创造模式玩家的能量仍遵循无限能量规则，会在后续会话 tick 恢复为最大值。

## 9. 节拍判定与战斗数据

当前战斗判定只使用 `timeline.combat_line`：

- 在排序后的时间线中二分查找当前时间前后的最近节拍；
- 读取该事件 `type` 对应的 definition；
- `can_attack=false` 直接判定失败，且该节拍不会推进“连续若干节拍未命中后重置连击”的计数；
- 当前时间落入 `tolerance` 窗口则命中；
- 命中结果携带 definition 的 `category`，由服务端结合出手武器标签计算最终倍率；
- 准星读取 `color`，并按 settings 决定未来节拍显示窗口。

`category` 的伤害规则：

- `normal` 或未知值：不修改伤害；
- `weakbeat`：默认造成 50% 伤害，出手武器属于 `djcraft:swift` 物品标签时保持 100%；
- `downbeat`：默认保持 100% 伤害，出手武器属于 `djcraft:smash` 物品标签时造成 150%。

标签与倍率均由服务端判定，并以攻击或发射瞬间的武器为准。内置标签中，重锤属于
`djcraft:smash`，三叉戟同时属于 `djcraft:swift` 和 `djcraft:smash`。数据包可按原版
物品标签规则扩展这两个标签。旧 `damage_rate` 字段已移除；即使旧曲目包仍包含该字段，
加载器也会忽略它。

服务端会根据客户端提交的判定时刻重新评估 proof，曲目定义哈希用于提示双端一致性，但当前播放入口没有强制 verified 状态（见下一节）。

快捷栏任一格或副手存在 `djcraft:note_in_a_bottle`（瓶中音符）时，玩家在 DJ 会话中的
可用空中多段跳次数增加 1。物品移入或移出这些位置时，服务端会在会话 tick 中实时更新
上限；背包其他位置不生效，携带多个也不会叠加。已经消耗的空中跳跃次数会保留到落地，
因此在空中反复移动物品不能恢复次数。

快捷栏任一格或副手存在 `djcraft:band_of_energy`（能量手环）时，玩家在 DJ 会话中的
最大能量增加 25。物品移入或移出这些位置时，服务端会实时重算并同步最大值；背包其他
位置不生效，携带多个也不会叠加。移出手环后，超过新上限的当前能量会被截断。

快捷栏任一格或副手存在 `djcraft:flowery` 时，DJ 冲刺的水平速度变为配置
`dashHorizontalSpeed` 的 1.5 倍。服务端在冲刺后的 20 tick 内检测玩家移动路径与敌对
生物接触；首次成功接触造成固定 9 点玩家攻击伤害，并将玩家当时剩余速度向量反向，
将本次 action sequence 计为最多 1 次连击，随后立即结束本次接触窗口。客户端在同一
20 tick 窗口显示沿用 100 连击色相算法的 6 GUI 像素宽彩虹窗口边框，并以 `2.0`
音量从四段 Flowery 语音中随机选择一段替代普通冲刺音效。该玩家还会每 50ms 产生一个
固定于捕获位置的彩虹玩家模型快照；每个快照仅在客户端渲染并于 0.5 秒内淡出，不创建实体，
且会同步触发给追踪该玩家的客户端。上述倍率、伤害、采样间隔和持续时间当前由 Java 固定，
不属于曲目包或物品时序 Profile schema。

三叉戟在 DJ 会话中使用专用动作规则：内置数据包默认让左键以 5 点能量执行 `4.5×3×3` 定向范围攻击，右键以 6 点能量即时投掷。两种动作都只在卡拍命中后扣能量；一次范围攻击或一次投掷即使命中多个实体，也只按同一个 action sequence 增加最多 1 连击。投掷物前 100 tick 无重力，可连续穿刺实体但不能穿透方块。能量成本属于服务器物品 Profile，可由数据包覆盖，不属于曲目包 schema；三叉戟同时具有 `swift` 和 `smash` 标签，类别倍率会应用于每个实际受伤目标。

重锤在 DJ 会话中同样使用定向范围攻击：内置数据包默认以 8 点能量攻击前方 `3×3×3` 区域，命中多个实体仍只按一次 action sequence 计算连击与耐久。下落重击的伤害适用于区域内各目标，原版重击附加声音和击退只触发一次。能量成本可通过服务器物品 Profile 覆盖，范围仍由 Java 固定。

## 10. 唱片统计与镀金状态

每张刻录唱片用 UUID 独立记录：

- 历史最大连击；
- 累计播放时长。

会话结束时，累计时长最多按 `total_duration_ms` 计入本次播放；最大连击取历史与本次较大值。唱片移动槽位后优先按 UUID 重新定位，槽位仅作为旧数据/后备定位。检测到重复 UUID 时会为重复唱片重新分配 UUID。

达到 80% 战斗节拍数的最大连击后显示镀金唱片。普通和镀金贴图都支持曲目包自定义。

## 11. 安全与校验

`.djcraft` 安全校验包括：

- 压缩文件必须为普通文件且不超过配置上限；
- 解压后累计读取字节也不能超过同一上限，防止 ZIP bomb；
- 最多 4096 个 ZIP entry；
- `track.json` 最大 1 MiB；
- 必须含根目录 `track.json`；
- 拒绝绝对路径、`..` 越界、反斜杠和冒号路径；
- 音频及任意可选资源读取也执行相对路径约束；
- 下载后校验整个归档 SHA-256，再进入加载流程。

加载器当前主要做结构解析和路径安全检查，不提供完整 JSON Schema 语义校验。缺失字段、非法范围和不存在的音频可能到较晚阶段才失败。

## 12. 未完成与已知限制

以下项目均以当前代码可达性为依据，不代表最终产品承诺。

### 12.1 明确未完成的曲目格式能力

1. **`meta.version` 版本协商未完成。** 字段已定义并解析，但没有支持版本列表、迁移器或拒绝未知版本的逻辑。
2. **`meta.difficulty` 玩法/UI 集成未完成。** 除调试摘要外没有消费者。
3. **definition 的 `scale` 未完成。** 准星和其他表现没有使用该值。
4. **definition 的 `haptic_intensity` 未完成。** 没有手柄震动/触觉反馈实现。
5. **definition 的 `particle` 未完成。** 没有粒子注册、解析或命中触发器。
6. **definition 的 `trigger` 未完成。** 没有条件语言或运行时条件判断。
7. **事件 `props` 覆盖机制未完成。** 数据会保留，但不会覆盖 definition，也没有业务消费者。
8. **特效轨调度未完成。** 非 `combat_line` 轨道会被加载到 `effectLines`，但没有按会话时钟派发灯光、粒子、镜头或其他效果。

### 12.2 部分完成或尚未贯通的流程

1. **verified 集合未强制用于播放和刻录。** `ClientTrackRegistry.isVerified()` 当前只用于 `/djclient download` 的重复下载判断。播放器 UI、客户端播放启动和刻录 UI 没有统一用 verified 集合过滤；服务端播放请求也不知道客户端实际哈希是否匹配。
2. **管理员 `/dj play` 不检查目标客户端资源。** 服务端可直接启动会话；目标客户端缺包时客户端启动失败，缺少自动下载/明确回执闭环。
3. **服务端只分发压缩包。** 目录包能加载、播放和覆盖同名归档，但不能通过下载协议提供给客户端。
4. **定义哈希不覆盖音频和美术资源。** 两端 `track.json` 一致但 OGG/PNG 不同时仍显示 verified。
5. **便携点唱机槽位约束不完整。** 当前允许未刻录的空白唱片进入 54 槽容器，也不在放入时检查曲目是否已加载。
6. **资源 ID 校验不完整。** `TrackPackIdValidator` 比 Minecraft `ResourceLocation` 规则宽松，含空格等 ID 可能通过加载，却在动态声音/模型/贴图注册阶段失败。
7. **JSON 语义验证不完整。** 未强制 `meta`、正数 BPM/时长、有效颜色、合法准星模式、非负时间、definition 引用完整性和有限数值。
8. **音频预检不完整。** 加载时登记音频路径，但目录包不会因文件不存在而拒绝加载；编码可播放性也不在加载阶段验证。
9. **`disc.jpg` 支持不一致。** ModernUI 播放器支持它作为普通封面后备，动态物品模型与资源枚举只支持 PNG。
10. **缺少曲目包作者工具链。** 仓库没有示例曲目包、JSON Schema、打包器、格式检查 CLI 或时间线编辑器；作者需手工制作并通过运行日志排错。
11. **下载没有图形界面和进度展示。** 当前入口是 `/djclient download`，消息只报告请求、成功或失败，没有百分比、速度、暂停或恢复。

### 12.3 DJ 组网

DJ 组网是服务端权威的临时播放组，已提供以下行为：

- 创建时快照创建者所选便携式点唱机的 54 个内部槽位，只保留服务端能够解析的已刻录唱片；槽位顺序和重复曲目都会保留。创建后再修改点唱机不会改变已有组网歌单。
- 创建者通过原播放器轮播和播放按钮点歌；顺序播放、单曲循环和随机播放的状态由服务端保存。顺序模式首尾循环，随机模式使用 shuffle bag，并在有其他歌曲时避免立即重复当前曲。
- 邀请接受者先进入准备中。客户端按曲目 ID 去重检查歌单所需曲包；缺失或完整内容不一致的可分发归档会串行下载，整批安装完毕后只刷新一次资源包。失败不会撤销邀请，可重试或退出。
- 目录型曲包、没有可分发归档或超过下载上限的曲包不能自动下载；客户端只有在本地已持有相同完整内容时才能完成准备。
- 每名玩家最多加入一个组网。只有当前房主可以点歌、切歌、切换模式和停止。房主离开或掉线时转交给最早加入且仍在线的正式成员；没有可接任成员时解散。
- 正式入组会停止个人 DJ 会话，组内不能另行开始个人播放。死亡不退出组网，重生后从当前播放位置恢复。管理员强制 `/dj play` 或 `/dj stop` 会先将目标移出组网。

组网校验使用“完整内容 SHA-256”，其输入是按相对路径排序后的每个文件路径、长度和内容，因此覆盖音频、美术和定义。该指纹与现有只表示 `track.json` 定义的哈希并存，不改变旧 API 的含义。下载协议仍按归档 SHA-256 校验传输文件本身。

组内每名玩家仍有独立的 session ID、能量、连击、容错、移动和战斗验证状态，但当前歌曲的服务端 `DJSession` 共享同一个 `GroupPlaybackClock`。客户端的 `DJSessionClient.getCurrentTimeMs()`、节拍、动画、判定、播放结束检测都继续读取各自 OpenAL source；服务端时间只用于服务端会话、一次性迟到定位和反作弊时钟偏移，不周期覆盖 OpenAL，也不执行常规漂移 seek。

创建者的源唱片仍按可重新定位的实体唱片引用记录统计。普通成员不会写唱片统计；房主转交后继续播放的歌曲也不会写入新房主的唱片。

玩家命令：

```text
/dj network create [jukeboxSlot]
/dj network invite <player>
/dj network accept <owner>
/dj network decline <owner>
/dj network retry
/dj network mode <sequential|repeat_one|shuffle>
/dj network play <index>
/dj network stop
/dj network leave
/dj network disband
/dj network status
```

## 13. 作者发布检查清单

- 使用仅含小写字母、数字、点、下划线和连字符的 `packId`。
- 将 `track.json` 和 OGG 放在目录或 ZIP 根目录。
- 明确填写全部 `meta` 字段，不依赖缺失字段回退。
- 使用毫秒编排 `combat_line`，并确保事件 `type` 能在 `definitions` 中找到。
- 为每种可攻击节拍设置合理的 `tolerance` 和 `category`。
- 当前不要依赖 `scale`、`haptic_intensity`、`particle`、`trigger`、`props` 或非战斗轨产生实际效果。
- 如需服务器下载，发布 `.djcraft`，不要只安装目录包。
- 控制压缩及解压总量低于服务器的 `maxTrackPackDownloadMiB`。
- 可选贴图优先使用 PNG；建议与 Minecraft 物品/GUI 贴图保持合适尺寸和透明通道。
- 安装后执行 `/dj reload`（服务端）或刻录 UI 的“重载曲包”（客户端），检查日志中的加载、哈希与资源刷新错误。
- 在多人环境分别验证：哈希同步、下载、刻录、点唱机存取、播放、停止/切歌、战斗判定、唱片统计与镀金贴图。

## 14. 主要代码索引

- 数据模型：`data/TrackPack.java`、`TrackMeta.java`、`TrackSettings.java`、`BeatDefinition.java`、`BeatEvent.java`、`Timeline.java`
- JSON 解析：`loader/TrackPackLoader.java`
- 扫描、哈希、文件流：`loader/TrackPackManager.java`
- 归档安全：`loader/TrackPackArchiveValidator.java`、`TrackPackIdValidator.java`
- 动态声音/模型/贴图：`sound/TrackPackResources.java`、`TrackPackRepositorySource.java`
- 双端哈希：`client/ClientTrackRegistry.java`、`network/packet/SyncTrackHashesPayload.java`
- 下载：`network/server/TrackPackTransferService.java`、`client/ClientTrackPackTransferService.java`
- 刻录：`client/ui/DJCraftingFragment.java`、`network/server/DJCraftingRequestHandler.java`
- 点唱机：`inventory/PortableJukeboxContainer.java`、`PortableJukeboxMenu.java`、`client/ui/DJPlayerFragment.java`
- 会话和判定：`session/DJSession.java`、`combat/BeatJudgmentEvaluator.java`
- 唱片数据：`data/DiscStatistics.java`、`session/DiscStatisticsService.java`
