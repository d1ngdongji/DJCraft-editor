Beat Track Studio 便携源码版
============================

系统要求：
- Windows 10/11 64 位
- 无需安装 Python、Conda、Node.js 或其他依赖

使用方法：
1. 完整解压 ZIP，不能直接在压缩软件内运行。
2. 双击 run.bat。
3. 首次启动会自动重定位 Python 环境，随后打开浏览器。
4. 保留 CMD 窗口；关闭窗口即停止后端。

轨道编辑：
- 页面采用全屏固定工作台，左侧图标栏切换“自动检测”“高级编辑”“资源管理”，三个分区共享同一曲目工程。
- 自动检测仅负责选择音频、调整检测参数、运行或重新运行检测，以及播放和时间线预览。
- 自动检测的节拍预览按固定 12 秒分页：背景在当前段内不移动，指示线到达右边界后切换至下一段并从左侧重新开始；可点击窗口定位，并用左右方向键按秒移动。
- 元数据、definitions、逐拍修改、批量操作、曲目包导入与导出统一放在高级编辑中。
- 高级编辑可上传已有 .djcraft 曲目包，解析其中的 track.json、音频和自定义资源后继续预览与编辑。
- 支持读取无压缩或 Deflate 压缩的 .djcraft；再次导出时保留包内未直接编辑的附加资源。
- 资源管理支持 beats/ 下的 PNG/GIF 下落节拍贴图、disc.png、perfect_disc.png 和 combo 数字贴图。
- 检测结果不自动生成 Downbeat，所有节拍默认使用 normal_beat。
- 新建或自动检测工程预置 normal_beat、empty_beat、weak_beat、strong_beat 定义；定义检查器可直接编辑 category（normal、weakbeat、downbeat）。
- 可编辑、增加或删除节拍定义及其任意键值对。
- 可逐个修改节拍定义，也可复选多个节拍后批量应用 type 或 props；批量 props 由内置的完整 math.js 15.2.0 浏览器版计算，支持丰富的数学函数、常量和数据类型，结果会逐项换算为 number、string 或 boolean，null 表示不修改该事件。
- 导出包包含 track.json、音频文件，以及可选的 disc.png。
- 导出时自动把源音频转码为 OGG/Vorbis，track.json 的 sound_file 同步改为 .ogg。
- 可编辑 version、author、BPM、difficulty、offset、playback_start_ms、总时长和 display_name；WAVEFORM 会遮罩起播位置之前的前段，以及实际音频超出 total_duration_ms 的尾段。
- display_name 提供 Minecraft §0～§f 颜色代码快捷插入。
- settings 支持 crosshair_mode=beat/time，并按模式启用节拍数量或毫秒间隔。

高级编辑：
- 可直接选择音频创建空白 combat_line，或导入已有曲目包后继续编辑。
- 多轨指 track.json 的 combat_line 与其他命名时间线轨；当前只包含一个音频文件，不是多音频 Stem 编辑器。
- 常用操作集中为图标工具栏；低频的选区批量操作通过工具按钮展开，右侧检查器保持事件、轨道、工程和定义的上下文编辑。
- 提供多分辨率振幅包络、已播放区着色、BPM 网格、波形拖动定位、时间标尺、横向缩放/滚动、自动跟随播放头、节拍网格吸附和 1/10/100 ms 精细移动。
- 密集事件在全曲视图下自动切换为细线概览，放大后恢复为更易选取和拖动的节拍标记。
- 支持单选、多选、同轨范围选择、跨轨框选、拖动、跨轨复制、剪切、粘贴、重复、量化、撤销与重做。
- 选区工具支持按个数或 BPM 生成中间节拍、周期改 type/删除，以及选区节拍数量翻倍/减半；同轨多选时以最早和最晚节拍作为选区边界。
- 工具栏的“♫ MIDI”可在本地解析 Standard MIDI format 0/1，并以钢琴卷帘显示 note；框选 note 后可用其持续区间内 0%（Note On）到 100%（Note Off）的指定位置生成节拍，再选择 definition 与目标轨道导入。超出当前曲目总时长的 note 会跳过。
- 可创建、重命名、排序和删除命名轨；combat_line 是必需轨道，不能重命名或删除。
- 工程检查器覆盖全部 meta、settings、definitions、事件 props，并保留未知扩展键；definition 可编辑 texture、落点、提前生成时间、命中/匹配命中/未命中行为和旋转速度。
- 高级编辑界面处于激活状态时均可使用常用快捷键（文字输入控件及 MIDI 弹窗除外）：Ctrl+Z/Y 撤销重做，Ctrl+C/X/V 复制剪切粘贴，Ctrl+D 重复，Delete 删除，Enter 创建，Space 播放；左右方向键移动 1 ms，Shift 为 10 ms，Ctrl 为 100 ms。

批量 props 表达式：
- 在高级编辑中复选多个事件后，可输入属性名和值表达式，再点击“计算并批量添加”。
- x 和 i 是按轨道、时间排序后的 0 起始序号，n 是 1 起始序号，t 是事件时间（ms），count 是所选事件总数。
- 使用 math.js 标准表达式语法：幂是 ^，逻辑运算是 and、or、not，比较是 ==、!=、<、<=、>、>=，条件表达式是“条件 ? 真值 : 假值”。
- 为兼容已有公式，也接受 **、&&、||、===、!==；这些写法会在字符串以外转换为对应的 math.js 语法。
- 支持 math.js 完整浏览器包中的函数、常量和运算类型，包括三角函数、对数、统计、组合数学、数组/矩阵、复数、分数、BigNumber、单位和隐式乘法；可使用自带的 clamp(value, min, max) 限制范围。
- 字符串需要放在单引号或双引号中；使用 text(a, b, ...) 把多个标量拼接成字符串。
- 表达式结果会直接写成 number、string 或 boolean，不会把公式文本写进 track.json；结果为 null 时不修改该事件已有的同名 prop。
- 数组、矩阵、复数和单位可以参与中间计算，但最终必须得到可保存的标量。纯实数的 Complex、Fraction 和 BigNumber 会安全换算为普通 number；非实复数、矩阵、数组和单位不能直接作为 prop。
- 为避免表达式修改计算环境，赋值、函数定义、多语句以及 import、createUnit、evaluate、parse、compile、parser、simplify、derivative、resolve、reviver 在批量表达式中禁用。

示例：
1. 按序号递增设置落点：
   属性名：landing_x_percent
   值表达式：20 + x * 10

2. 把事件时间换算为整数秒：
   属性名：second
   值表达式：round(t / 1000)

3. 每四个事件中的第 1、2 个使用不同贴图，其余事件保持原值：
   属性名：texture
   值表达式：x % 4 == 0 ? "beats/a.png" : x % 4 == 1 ? "beats/b.png" : null

4. 根据序号自动拼接贴图路径：
   属性名：texture
   值表达式：text("beats/beat_", x % 4, ".png")

5. 同时满足“偶数序号”和“前 30 秒”时允许攻击：
   属性名：can_attack
   值表达式：x % 2 == 0 and t < 30000

6. 计算数值并限制在 0～100：
   属性名：landing_x_percent
   值表达式：clamp(round(20 + x * 7.5), 0, 100)

7. 为前三个事件设置旋转速度，其余事件不修改：
   属性名：rotation_rpm
   值表达式：x < 3 ? 2^x * 15 : null

8. 使用三角函数和常量生成周期数值：
   属性名：wave
   值表达式：round(50 + 50 sin(2 pi x / count))

9. 使用统计函数从数组中计算标量：
   属性名：average
   值表达式：mean([x, n, count])

10. 使用矩阵计算行列式：
    属性名：determinant
    值表达式：det([[x + 1, 2], [3, n]])

11. 使用复数完成中间计算，再取可保存的模：
    属性名：distance
    值表达式：abs(complex(x, n))

12. 把英寸换算为厘米数值：
    属性名：length_cm
    值表达式：number(2 inch, "cm")

13. 继续使用旧的类 JavaScript 写法（兼容示例）：
    属性名：can_attack
    值表达式：x % 2 === 0 && t < 30000

运行时能力提示：
- 非 combat_line 命名轨以及 definition 的 haptic_intensity、particle、trigger 可以编辑和保存，但 DJCraft 当前仍未调度或消费这些预留能力。
- definition 的 scale、texture、landing_x_percent、spawn_advance_ms、hit_behavior、matched_hit_behavior、miss_behavior、rotation_rpm 及同名事件 props 已用于 Falling beat 呈现。

目录说明：
- webui_server.py：后端源码
- webui/：前端源码
- webui/vendor/mathjs/：随程序离线分发的 math.js 15.2.0 完整浏览器包及 Apache-2.0 许可证
- runtime/：可迁移 Python 3.12 环境、Madmom 模型及全部依赖
- run.bat：启动入口

默认地址：http://127.0.0.1:8765

注意：
- 请勿单独移动 runtime 内部文件。
- 如果 8765 端口被占用，请先关闭旧的 Beat Track Studio 后端。
- 程序只监听本机地址，上传的音频不会发送到网络。
