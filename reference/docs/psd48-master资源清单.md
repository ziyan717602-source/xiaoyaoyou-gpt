# 仙剑逍遥游 Web 版 - psd48-master资源清单

> 基于 C# WPF 项目 `reference/psd48-master/` 的完整资源梳理
> 创建日期：2026-06-02

---

## 目录

1. [卡牌资料系统](#1-卡牌资料系统)
2. [回合流程系统](#2-回合流程系统)
3. [技能/效果处理系统](#3-技能效果处理系统)
4. [卡图资源](#4-卡图资源)
5. [动画资源](#5-动画资源)
6. [音频资源](#6-音频资源)
7. [前端实现参考](#7-前端实现参考)
8. [关键架构总结](#8-关键架构总结)

---

## 1. 卡牌资料系统

### 1.1 数据源

**数据库文件**: `reference/psd48-master/~ex-lib/psd.db3` (SQLite)

**加载方式**: 通过 `PSDBase/LibGroup.cs` 统一加载到以下库：

| 库名 | 类 | 内容 |
|------|-----|------|
| HL | HeroLib | 英雄库 |
| TL | TuxLib | 手牌库 |
| NL | NPCLib | NPC库 |
| ML | MonsterLib | 怪物库 |
| EL | EvenementLib | 事件库 |
| SL | SkillLib | 技能库 |
| ZL | OperationLib | 操作库 |
| NJL | NCActionLib | NPC动作库 |
| RL | RuneLib | 符文库 |
| ESL | ExspLib | 特殊卡库 |

### 1.2 英雄（Hero）

**定义文件**: `PSDBase/Card/Hero.cs`

**关键属性**:
- `Name` - 英雄名称
- `Avatar` - 头像编号（如 10502）
- `Ofcode` - 编码（如 XJ101, TR001）
- `Group` - 包编号（1=标准, 2=凤鸣峪石, 4=SP, 5=三十轮回, 7=云来起源）
- `HP` - 生命值
- `STR` - 战力
- `DEX` - 命中
- `Gender` - 性别
- `Skills` - 技能列表
- `Spouses` - 配偶列表
- `Isomorphic` - 同构英雄
- `Archetype` - 原型
- `Antecessor` - 前身
- `Pioneer` - 后继
- `Bio` - 传记

**别名系统**:
- `TokenAlias` - 令牌别名
- `PeopleAlias` - 人物别名
- `PlayerTarAlias` - 玩家目标别名
- `ExCardsAlias` - 扩展卡牌别名
- `AwakeAlias` - 觉醒别名
- `FolderAlias` - 文件夹别名
- `GuestAlias` - 客串别名

**数据库表结构**:
```sql
Hero(ID, GENRE, VALID, OFCODE, NAME, HP, STR, DEX, GENDER, SPOUSE, ISO, SKILL, ALIAS, BIO)
```

**卡图资源**:
- 缩略图: `PSDRisoLib/Resources/Heros/` (10101.png, 17001.png 等)
- 全卡图: `PSDRisoLib/Resources/Card/_Full/Heros/` (XJ101.png, TR001.png 等)
- 标准卡图: `PSDRisoLib/Resources/Card/Heros/`

### 1.3 怪物（Monster）

**定义文件**: `PSDBase/Card/Monster.cs`

**关键属性**:
- `Name` - 怪物名称
- `Code` - 编码（如 GS01, GH01）
- `Element` - 五行元素
- `Level` - 等级（WOODEN/WEAK/STRONG/BOSS）
- `STRb` - 基础战力
- `AGLb` - 基础敏捷
- `EAOccurs` - 效果触发条件
- `EAProperties` - 效果属性

**五行元素映射**:
| 编码 | 元素 | 英文 |
|------|------|------|
| GS | 水 | AQUA |
| GH | 火 | AGNI |
| GL | 雷 | THUNDER |
| GF | 风 | AERO |
| GT | 土 | SATURN |
| GI | 阴 | YINN |
| GY | 阳 | SOLARIS |

**文本属性**:
- `DebutText` - 出场文本
- `PetText` - 宠物文本
- `WinText` - 胜利文本
- `LoseText` - 失败文本

**效果系统**:
- `SPI` - 伤害/手牌参与判定的位掩码系统
- 委托: Debut(出场), Curtain(退场), WinEff/LoseEff(胜负效果)
- 消耗: IncrAction/DecrAction, ConsumeAction/ConsumeInput/ConsumeValid
- 内存: ROM(全局), RFM(回合内), RAM(阶段内) 三级记忆

**卡图资源**:
- 全卡图: `PSDRisoLib/Resources/Card/_Full/NMB/` (GS01.png, GH01.png 等)
- 标准卡图: `PSDRisoLib/Resources/Card/NMB/`
- 缩略图: `PSDRisoLib/Resources/PetsSnap/`

### 1.4 手牌（Tux）

**定义文件**: `PSDBase/Card/Tux.cs`

**手牌类型 (TuxType)**:
| 类型 | 名称 | 说明 |
|------|------|------|
| HX | 黑匣 | 特殊手牌 |
| JP | 锦牌 | 锦牌 |
| ZP | 赠牌 | 赠牌 |
| TP | 特牌 | 特牌 |
| WQ | 武器 | 武器装备 |
| FJ | 防具 | 防具装备 |
| XB | 仙宝 | 仙宝装备 |

**装备子类**:
- `TuxEqiup` - 装备基类
  - `IncrOfSTR/IncrOfDEX` - 属性加成
  - `ConsumeAction/ConsumeValid` - 消耗系统
- `Luggage` - 行李牌（可存储 Capacities 卡牌容量）
- `Illusion` - 幻象牌（ILAS 当前映射）

**委托系统**:
- `Action` - 使用效果
- `Vestige` - 残影效果
- `Valid` - 有效性判定
- `Input` - 输入请求
- `Encrypt` - 加密
- `Locust` - 蝗虫效果

**编码规则**:
- JP = 锦牌
- ZP = 赠牌
- TP = 特牌
- WQ = 武器
- FJ = 防具
- XB = 仙宝

**卡图资源**:
- 全卡图: `PSDRisoLib/Resources/Card/_Full/Tux/` (JP01.png, WQ01.png 等)
- 标准卡图: `PSDRisoLib/Resources/Card/Tux/`
- 装备缩略图: `PSDRisoLib/Resources/EquipSnap/`

### 1.5 NPC

**定义文件**: `PSDBase/Card/Npc.cs`

**关键属性**:
- `Name` - NPC名称
- `Code` - 编码（如 NC101）
- `Gender` - 性别
- `STR` - 战力
- `Skills` - 技能列表
- `Hero` - 关联英雄编号
- `DebutText` - 出场文本

**编号规则**: 原始 ID 1000+偏移存储在 NMB 系统中

**NMB 接口**: `PSDBase/Card/NMB.cs`
- Monster 和 NPC 的共同接口
- ID < 1000 为怪物
- 1000 < ID < 2000 为 NPC

**卡图资源**: 与怪物共用 NMB 卡图目录

### 1.6 事件（Evenement）

**定义文件**: `PSDBase/Card/Evenement.cs`

**关键属性**:
- `Name` - 事件名称
- `Code` - 编码（如 SJ101）
- `Range` - 编号范围
- `Background` - 背景
- `Description` - 描述
- `Occurs/Priorties/IsOnce/IsTermini/Lock` - 触发配置

**委托**:
- `Action` - 主效果
- `Pers` - 持续效果
- `PersValid` - 持续有效性

**卡图资源**:
- 全卡图: `PSDRisoLib/Resources/Card/_Full/Eve/` (SJ101.png 等)
- 标准卡图: `PSDRisoLib/Resources/Card/Eve/`

### 1.7 其他卡牌类型

**五行元素**: `PSDBase/Card/FiveElement.cs`
- AQUA(水), AGNI(火), THUNDER(雷), AERO(风), SATURN(土), YINN(阴), SOLARIS(阳)

**Exsp（特殊卡）**: `PSDBase/Card/Exsp.cs`
- 类型: 0-通用, 1-目标, 2-令牌, 3-卡牌, 4-标记
- 卡图: `PSDRisoLib/Resources/Card/ExSp/` (EP001~EP027.png)

**Rune（符文）**: `PSDBase/Rune.cs`
- 正面/负面/高级符文系统
- 卡图: `PSDRisoLib/Resources/Card/RuneCard/` (SF01~SF08.png)

**Card 枚举**: `PSDBase/Card/Card.cs`
- Genre: NIL, Tux(C), NMB(M), Eve(E), TuxSerial(G), Rune(F), Five(V), Exsp(I), Hero(H), NPC(N)

---

## 2. 回合流程系统

### 2.1 游戏主循环

**入口文件**: `PSDGamepkg/XIS.cs`
- `XI.Run()` 方法：初始化牌堆、注册所有效果委托、进入回合循环

**回合控制**: `PSDGamepkg/XIR.cs`
- `XI.RunRound()` 方法：实现完整回合流程

### 2.2 回合阶段结构

| 阶段代码 | 含义 | 说明 |
|----------|------|------|
| `R{N}00` | 回合开始 | 检查是否被定身，定身则跳过 |
| `R{N}OC` | 开始阶段重置 | 重置所有玩家 RAM |
| `R{N}ST` | 开始阶段 | 广播开始信号 |
| `R{N}EP` | 结束准备 | 重置 RAM |
| `R{N}EV` | 事件阶段 | 决定是否翻看事件牌 |
| `R{N}EE` | 事件执行 | 执行事件效果 |
| `R{N}GS` | 获取阶段开始 | 重置 RAM |
| `R{N}GR` | 获取阶段 | 混合阶段处理 |
| `R{N}GE` | 获取结束 | |
| `R{N}Z0` | 战斗准备 | 清空怪物池、重置战斗状态 |
| `R{N}ZW` | 支援/妨碍选择 | 选择支援者和妨碍者 |
| `R{N}ZU` | 战斗前阶段 | |
| `R{N}ZM` | 怪物翻出 | 从怪物牌堆翻出怪物 |
| `R{N}NP` | NPC 处理 | 如果翻出的是 NPC，执行 NPC 效果 |
| `R{N}Z1` | 战斗开始 | 设置静默、激活 ABC 值系统 |
| `R{N}Z8` | 战斗中间阶段 | |
| `R{N}CC` | 怪物出场 | 执行怪物 Debut 效果 |
| `R{N}PD` | 战斗判定 | |
| `R{N}ZC` | 玩家池激活 | 激活玩家 ABC 值 |
| `R{N}ZD` | 战斗结束处理 | 消耗宠物处理 |
| `R{N}ZF` | 战斗结算 | 胜负判定、奖惩 |
| `R{N}ED` | 回合结束 | |
| `H0TM` | 游戏结束 | |

### 2.3 选人模式系统

**规则定义**: `PSDBase/Rules/RuleCode.cs`

**选人模式**:
| 代码 | 名称 | 说明 |
|------|------|------|
| 00 | 监管 | 监管模式 |
| CJ | 召唤 | 召唤模式 |
| 31 | 三选一 | 三选一模式 |
| RM | 随机 | 随机模式 |
| BP | 禁选 | 禁选模式 |
| RD | 轮选 | 轮选模式 |
| ZY | 昭鹰 | 昭鹰模式 |
| CP | 协同 | 协同模式 |
| IN | 客栈 | 客栈模式 |
| SS | 北软 | 北软模式 |
| NM | 普通 | 普通模式 |
| TC | 明暗 | 明暗模式 |
| CM | 队长 | 队长模式 |

**房间等级**: NEW(新手), STD(标准), RCM(推荐), ALL(全部), IPV(界限突破)

**选人实现**: `PSDBase/Rules/Casting.cs`
- CastingPick, CastingTable, CastingPublic, CastingCongress 四种选人方式

### 2.4 玩家与棋盘

**Player**: `PSDBase/Player.cs`
- 账户信息
- 属性: HP/STR/DEX 及其变体
- 卡牌: 手牌/装备/宠物/符文
- 状态: 禁卡/沉默/定身/倾慕
- 记忆: ROM/RFM/RAM 三级

**Board**: `PSDBase/Board.cs`
- 回合者 (Rounder)
- 支援者 (Supporter)
- 妨碍者 (Hinder)
- 战斗参与者
- 牌堆: TuxPiles/MonPiles/EvePiles
- 弃牌堆
- ABC 值池系统

---

## 3. 技能/效果处理系统

### 3.1 技能定义

**Skill**: `PSDBase/Skill.cs`
- `Name` - 技能名称
- `Code` - 技能编码
- `Occurs` - 触发条件
- `Priorities` - 优先级
- `IsOnce` - 是否一次性
- `IsTermini` - 是否终止
- `Lock` - 锁定
- `IsHind` - 是否妨碍
- `Parasitism` - 寄生链
- `Descripe` - 描述

**Bless**: 继承 Skill，增加 BKValid 委托（祝福类技能）

**SKBranch**: `PSDBase/SKBranch.cs`
- 技能分支配置
- Occur, Priority, Once, Serial, Hind, Demiurgic, Lock 等属性

### 3.2 技能/效果触发系统（核心架构）

**XI 主类**: `PSDGamepkg/XI.cs`

**核心映射表**:
| 映射表 | 内容 |
|--------|------|
| sk01 | 技能名 -> Skill 对象 |
| sk02 | 触发条件 -> SkTriple 列表 |
| sk03 | 寄生链映射 |
| tx01 | 手牌名 -> Tux 对象 |
| mt01 | 怪物名 -> Monster 对象 |
| cz01 | 操作名 -> Operation 对象 |
| nj01 | NPC 效果名 -> NCAction 对象 |
| ev01 | 事件代码 -> Evenement 对象 |
| sf01 | 符文名 -> Rune 对象 |

### 3.3 SkTriple/SKE 触发系统

**定义**: `PSDGamepkg/XIU.cs`

**SKTType 枚举**:
| 类型 | 说明 |
|------|------|
| SK | 技能 |
| BK | 祝福 |
| TX | 手牌 |
| EQ | 装备 |
| CZ | 操作 |
| NJ | NPC效果 |
| PT | 宠物 |
| EV | 事件 |
| SF | 符文 |
| YJ | 未知 |

**SkTriple** - 触发三元组:
- Name, Priorty(优先级), Owner(持有者)
- InType(触发类型), Type(效果类型)
- Consume(消耗类型: 0-持续/1-一次性/2-背景)
- Lock, IsOnce, Occur, LinkFrom, IsTermini

**SKE** - SkTriple 的运行时实例:
- Fuse(触发源), Tick(使用次数), Tg(实际触发者)

### 3.4 G-消息系统（效果处理核心）

**文件**: `PSDGamepkg/XIG.cs`

**RaiseGMessage**: 触发 G 消息的入口

**InnerGMessage**: 带优先级控制的消息处理

**技能响应链流程**:
1. 查找 sk02 中匹配的 SkTriple 列表
2. 按优先级排序
3. 对每个 SKE 发送 U1 消息询问玩家是否发动
4. 处理玩家响应（UEchoCode）
5. 终止或继续处理下一个优先级

**UEchoCode**:
- STRANGE - 异常
- RE_REQUEST - 重新请求
- NO_OPTIONS - 无选项
- NEXT_STEP - 下一步
- END_CANCEL - 取消结束
- END_ACTION - 动作结束
- END_TERMIN - 终止结束

### 3.5 效果实现注册

**文件**: `PSDGamepkg/XI.cs` 中 Run() 方法

**注册方式**: 通过各种 Cottage 类注册委托到对应的 Lib 对象:

| Cottage 类 | 目标 | 内容 |
|------------|------|------|
| TuxCottage | tx01 | 手牌效果 |
| SkillCottage | sk01 | 技能效果 |
| OperationCottage | cz01 | 操作效果 |
| NPCCottage | nj01, nl | NPC 效果 |
| EveCottage | ev01 | 事件效果 |
| RuneCottage | sf01 | 符文效果 |
| MonsterCottage | mt01 | 怪物效果 |

### 3.6 效果实现文件（JNS 目录）

**基础类**: `PSDGamepkg/JNS/JNSBase.cs`
- Harm(伤害), Cure(治疗), TargetPlayer 等通用方法

**具体实现文件示例**:
| 文件 | 类型 | 说明 |
|------|------|------|
| CZ02.cs | 操作效果 | 操作效果实现 |
| FG04.cs | 防具效果 | 防具效果实现 |
| HL014.cs | 英雄技能 | 英雄技能实现 |
| JP06.cs | 锦牌效果 | 锦牌效果实现 |
| NC303.cs | NPC效果 | NPC效果实现 |
| SF09.cs | 符文效果 | 符文效果实现 |
| SJ101.cs | 事件效果 | 事件效果实现 |
| TR007.cs | 英雄技能 | 英雄技能实现 |
| XJ405.cs | 英雄技能 | 英雄技能实现 |

### 3.7 Artiad 命名空间（游戏机制实现）

**目录**: `PSDGamepkg/Artiad/`

**关键文件**:
| 文件 | 功能 |
|------|------|
| HPIssue.cs | 伤害(Harm)/治疗(Cure)系统，G0OH/G0IH/G1TH 消息 |
| Coaching.cs | 战斗参与者管理（支援者/妨碍者/号角者） |
| Customs.cs | 弃牌系统(Abandon)，G0ON 消息 |
| Clothing.cs | 装备系统(EquipStandard/EquipExCards)，G0ZB 消息 |
| ContentRule.cs | 内容规则（英雄可用性判定、宠物归属等） |
| Procedure.cs | 流程工具（令牌清除、客串英雄管理等） |
| NGT.cs | 消息基类 |
| Pond.cs | ABC 值池系统 |
| ImperialOrder.cs | 怪物区域管理 |
| JanuaryMan.cs | 手牌管理 |
| BHW.cs | 辅助工具 |
| Kitty.cs | 宠物系统 |
| Little.cs | 其他效果 |
| GotoNoodle.cs | 跳转系统 |

### 3.8 Operation（操作）

**定义**: `PSDBase/Operation.cs`
- 通用操作类
- 包含 Action/Valid/Input 委托

### 3.9 NCAction（NPC 动作）

**定义**: `PSDBase/NCAction.cs`
- NPC 效果动作
- 支持普通和 Escue(庇护) 两种模式
- 包含 Branches(SKBranch 数组) 配置

---

## 4. 卡图资源

所有图片资源位于 `PSDRisoLib/Resources/` 目录下。

### 4.1 英雄卡图

| 资源类型 | 目录 | 命名规则 | 示例 |
|----------|------|----------|------|
| 缩略图 | `Heros/` | {编号}.png | 10101.png, 17001.png |
| 全卡图 | `Card/_Full/Heros/` | {Ofcode}.png | XJ101.png, TR001.png |
| 标准卡图 | `Card/Heros/` | {Ofcode}.png | HL001.png |
| 名字条 | `NameBar/` | Name{Ofcode}.png | NameXJ101.png |

### 4.2 怪物/NPC 卡图

| 资源类型 | 目录 | 命名规则 | 示例 |
|----------|------|----------|------|
| 全卡图 | `Card/_Full/NMB/` | {Code}.png | GS01.png, GH01.png |
| 标准卡图 | `Card/NMB/` | {Code}.png | NC101.png |
| 缩略图 | `PetsSnap/` | {Code}.png | - |

### 4.3 手牌卡图

| 资源类型 | 目录 | 命名规则 | 示例 |
|----------|------|----------|------|
| 全卡图 | `Card/_Full/Tux/` | {Code}.png | JP01.png, WQ01.png |
| 标准卡图 | `Card/Tux/` | {Code}.png | - |
| 装备缩略图 | `EquipSnap/` | {Code}.png | - |

### 4.4 事件卡图

| 资源类型 | 目录 | 命名规则 | 示例 |
|----------|------|----------|------|
| 全卡图 | `Card/_Full/Eve/` | {Code}.png | SJ101.png |
| 标准卡图 | `Card/Eve/` | {Code}.png | - |

### 4.5 其他卡图

| 类型 | 目录 | 命名规则 | 示例 |
|------|------|----------|------|
| 特殊卡 | `Card/ExSp/` | EP{NNN}.png | EP001~EP027.png |
| 五行卡 | `Card/Five/` | WL{NN}.png | WL01~WL09.png |
| 符文卡 | `Card/RuneCard/` | SF{NN}.png | SF01~SF08.png |
| 骰子 | `Card/Dices/` | Dice{N}.png | Dice1~Dice7.png |

### 4.6 UI 素材

| 类型 | 目录 | 说明 |
|------|------|------|
| 登录背景 | `Logo/LoginBgimg.jpg` | 登录界面背景 |
| 图标 | `Logo/` | CZ/DT/BZ 系列图标 |
| 胜利/失败 | `Logo/Canan/` | 倒计时、胜负图标 |
| 音量控制 | `Logo/` | 音量相关图标 |
| 守护 | `Guard/` | L0~L21.png |
| 令牌 | `Token/` | N01~N10.png + 英雄专属令牌 |
| 状态图标 | `StatusIcon/` | Ds.png(定身), lvd.png(等级) |
| 玩家标识 | `Players/` | GIchi/GNi/GSan/GYong/GGo/GRoku.png |
| 缓冲效果 | `Buffer/` | SF01~SF12.png |
| 头像 | `Avatar/` | 各英雄头像 |
| 堆场 | `PilesField/` | RedBall.png, BlueBall.png |

### 4.7 资源字典

**图片映射**: `PSDRisoLib/Resources/ImgRes.xaml`
- XAML 资源字典
- 定义所有图片资源的 Key 映射

---

## 5. 动画资源

项目中没有发现独立的动画资源文件（如 GIF、序列帧、Spine 等）。

动画效果主要通过 WPF 的内置动画机制实现：
- **卡牌控件**: `PSDClientAo/Card/` 目录下的 XAML 文件可能包含 WPF 动画/故事板
- **UI 控件**: 各 `.xaml` 文件中可能定义了 WPF 触发器动画

**Web 版动画实现建议**:
- 使用 CSS 动画/过渡
- 使用 Canvas/WebGL 动画库（如 PixiJS, Phaser）
- 使用 Lottie 处理 After Effects 导出的动画

---

## 6. 音频资源

### 6.1 音效文件

**位置**: `PSDRisoLib/Resources/Voice/`

**格式**: OGG (Vorbis)

**背景音乐**:
- `Voice/fmxy.ogg` - 登录界面背景音乐

**英雄语音 - 技能包6(JN)**:
- 目录: `Voice/Pkg6-JN/`
- 约 90 个文件
- 格式: `JNT2301-1.ogg`, `JNT4502-2.ogg`

**英雄语音 - 朝阳包(ZY)**:
- 目录: `Voice/Pkg6-ZY/`
- 约 40 个文件
- 格式: `TR023-IY.ogg`(入场), `TR023-ZW.ogg`(战吼)

### 6.2 音效资源映射

**映射文件**: `PSDRisoLib/Resources/VocalRes.xaml`
- XAML 资源字典
- 格式: `voiceJNT2301_1_0` -> `Voice/Pkg6-JN/JNT2301-1.ogg`

### 6.3 音效播放系统

| 文件 | 功能 |
|------|------|
| `PSDClientAo/Voice/AoVoice.cs` | 音效管理器，使用 BlockingCollection 队列，后台线程播放 |
| `PSDClientAo/Voice/VoiceEntry.cs` | 单个音效播放器，使用 NAudio.Vorbis 解码 OGG |
| `PSDClientAo/Voice/Soundtracker.xaml.cs` | 音效控制 UI 控件 |

**依赖库**: `lib/` 目录
- NAudio.dll
- NAudio.Vorbis.dll
- NVorbis.dll

### 6.4 Web 版音频实现建议

- 使用 Web Audio API
- 使用 Howler.js 等音频库
- 支持 OGG 和 MP3 格式
- 实现音效队列和静音功能

---

## 7. 前端实现参考

### 7.1 主窗口

**AoDisplay**: `PSDClientAo/AoDisplay.xaml.cs`
- 主游戏窗口
- 支持模式: Hall(大厅), Direct(直连), Replay(回放), Reconnection(重连), Watch(观战)

**XAML**: `PSDClientAo/AoDisplay.xaml`

### 7.2 登录系统

| 文件 | 功能 |
|------|------|
| `PSDClientAo/Login/LoginDoor.xaml.cs` | 登录窗口 |
| `PSDClientAo/Login/LoginDoor.xaml` | 登录界面 |
| `PSDClientAo/Login/RoomView.xaml.cs` | 房间列表视图 |
| `PSDClientAo/Login/RoomView.xaml` | 房间列表界面 |

### 7.3 玩家面板

| 文件 | 功能 |
|------|------|
| `PSDClientAo/PlayerBoard.xaml.cs` | 玩家信息面板 |
| `PSDClientAo/PlayerBoard.xaml` | 面板界面 |
| `PSDClientAo/AoPlayer.cs` | 玩家数据绑定模型 |

**显示内容**: 英雄头像、HP、STR、DEX、装备、宠物、状态图标

### 7.4 卡牌控件

**目录**: `PSDClientAo/Card/`

| 控件 | 文件 | 功能 |
|------|------|------|
| Ruban | `Ruban.xaml.cs` | 标准卡牌控件 |
| RubanBox | `RubanBox.xaml.cs` | 装备槽控件 |
| RubanLock | `RubanLock.xaml.cs` | 锁定装备槽 |
| Hitori | `Hitori.xaml.cs` | 单卡显示控件 |
| Mystic | `Mystic.xaml.cs` | 神秘卡控件 |
| MysticV | `MysticV.xaml.cs` | 神秘卡垂直控件 |
| Nikojin | `Nikojin.xaml.cs` | NPC 卡控件 |
| Suban | `Suban.xaml.cs` | 子卡控件 |
| ShipRule | `ShipRule.cs` | 卡牌规则配置 |
| MoveThumb | `MoveThumb.cs` | 拖拽控件 |

**Ruban 状态**:
- Location: BAG/WATCH/DEAL
- Category: ACTIVE/SOUND/LUMBERJACK/PISTON/AO_MASK/AKA_MASK

### 7.5 游戏界面组件

| 组件 | 文件 | 功能 |
|------|------|------|
| PilesBar | `PSDClientAo/PilesBar.xaml.cs` | 牌堆显示栏 |
| PersonalBag | `PSDClientAo/PersonalBag.xaml.cs` | 个人手牌袋 |
| RepoAngle | `PSDClientAo/RepoAngle.xaml.cs` | 角度报告 |
| Speeder | `PSDClientAo/Speeder.xaml.cs` | 回放速度控制 |
| CananPaint | `PSDClientAo/CananPaint.xaml.cs` | 绘图面板 |
| Moonlight | `PSDClientAo/Moonlight.xaml.cs` | 月光效果 |
| Orchis40 | `PSDClientAo/Orchis40.xaml.cs` | 兰花面板 |
| JoyStick | `PSDClientAo/JoyStick.xaml.cs` | 操控杆 |

### 7.6 OI 子系统（游戏交互）

**目录**: `PSDClientAo/OI/`

| 组件 | 文件 | 功能 |
|------|------|------|
| AoTV | `AoTV.cs` | 电视效果/消息展示 |
| Television | `Television.xaml.cs` | 电视界面 |
| AoArena | `AoArena.cs` | 竞技场/战斗界面 |
| Arena | `Arena.xaml.cs` | 竞技场界面 |
| AoDeal | `AoDeal.cs` | 发牌界面 |
| DealTable | `DealTable.xaml.cs` | 发牌桌界面 |
| AoMinami | `AoMinami.cs` | 南方效果 |
| NumberPad | `NumberPad.xaml.cs` | 数字输入面板 |

### 7.7 辅助 UI

| 组件 | 文件 | 功能 |
|------|------|------|
| IchiDisplay | `PSDClientAo/Tips/IchiDisplay.cs` | Tooltip 生成器 |
| MessageHouse | `PSDClientAo/Auxs/MessageHouse.xaml.cs` | 消息对话框 |
| Hour | `PSDClientAo/Request/Hour.xaml.cs` | 计时控件 |

### 7.8 客户端逻辑

| 文件 | 功能 |
|------|------|
| `PSDClientAo/ZI.cs` | 客户端主控制器 |
| `PSDClientAo/XIVisi.cs` | 可视化交互控制器 |
| `PSDClientAo/AoMix.cs` | 混合控制器 |
| `PSDClientAo/AoField.cs` | 场地控制器 |
| `PSDClientAo/AoCEE.cs` | CEE 控制器 |
| `PSDClientAo/AoMe.cs` | 个人控制器 |
| `PSDClientAo/AoOrchis.cs` | Orchis 控制器 |

---

## 8. 关键架构总结

### 8.1 数据驱动

- 所有卡牌数据从 `psd.db3` SQLite 数据库加载
- 运行时通过各种 Lib 类管理
- 资源字典（XAML）管理图片和音效映射

### 8.2 委托模式

- 技能/效果全部通过 C# 委托(Action/Valid/Input)注册
- 运行时动态调用
- Web 版可使用函数指针/回调模式实现

### 8.3 消息驱动

- 游戏逻辑通过 G 消息系统驱动
- G0xx = 基础消息
- G1xx = 扩展消息
- G2xx = 系统消息
- 技能通过 U 消息与玩家交互

### 8.4 优先级队列

- 技能响应按优先级排序处理
- 支持锁定/终止/一次性等属性
- 实现复杂的技能连锁反应

### 8.5 三级记忆

| 记忆级别 | 名称 | 作用域 |
|----------|------|--------|
| ROM | 全局记忆 | 整个游戏 |
| RFM | 回合记忆 | 当前回合 |
| RAM | 阶段记忆 | 当前阶段 |

### 8.6 WPF MVVM（Web 版可借鉴）

- 客户端使用 WPF 数据绑定
- AoPlayer 等类作为 ViewModel
- Web 版可使用 React/Vue 的响应式数据绑定

---

## 9. 开发建议

### 9.1 数据导出

1. 从 `psd.db3` 导出所有卡牌数据为 JSON
2. 整理到 `src/shared/data/` 目录
3. 创建 TypeScript 类型定义

### 9.2 资源迁移

1. 提取所有卡图资源到 Web 可访问目录
2. 转换音频格式（OGG 保持或转 MP3）
3. 创建资源映射配置文件

### 9.3 架构设计

1. 服务端：实现游戏逻辑（参考 XI.cs, XIR.cs）
2. 客户端：实现响应式 UI（参考 AoDisplay, PlayerBoard）
3. 通信：WebSocket 实时通信

### 9.4 参考优先级

1. 首先实现核心游戏循环（回合流程）
2. 实现基础卡牌效果（参考 JNS 目录）
3. 实现 UI 界面（参考 XAML 文件）
4. 添加音频和动画效果

---

> 本清单基于 C# WPF 项目分析，为 Web 版开发提供参考。
> 具体实现时需根据 Web 技术栈进行调整。
