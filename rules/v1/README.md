# 技术标自检规则库 · 填写说明

这套 CSV 是自检器的**唯一规则来源**，由业务专家直接编辑，不需要动代码。
改完运行 `node --no-warnings src/selfcheck-validate.ts` 校验，通过后
`node --no-warnings src/tech-bid-check.ts --bid=xxx.docx --title=yyy` 就会用新规则。

## 三张表的分工

| 文件 | 一行代表 | 谁维护 |
|---|---|---|
| `topics.csv` | 一个章节（考什么范围） | 开发，偶尔加 |
| `checks.csv` | 一个检查项（要看到什么） | **专家，主要工作在这里** |
| `tiers.csv` | 一个档位（看到几项算哪档） | 专家 |

## topics.csv

```
topic_id,name,applies_to,headings,parent
SG-SITE,施工现场平面布置,通用,施工平面布置|平面布置|总平面布置|
```

- `topic_id`：稳定不变，改了会断掉所有引用
- `applies_to`：`通用` 或具体类型，多个用 `|` 分隔（如 `房建|市政`）
- `headings`：**标题别名**，技术标里出现这些词就认为进入本章节，多个用 `|`
  - 写最具体的在前，匹配时长别名优先
- `parent`：留空表示顶层

## checks.csv

```
check_id,topic_id,title,aliases,evidence,reject_if_missing,source,reviewed,expert_note
```

- `check_id`：`SG-SITE-01` 这种格式，稳定不变
- `aliases`：这条检查项在评分表里可能叫什么，多个用 `|`（用于把评分项对到规则）
- `evidence`：**要看到什么证据**，多项用中文分号 `；` 分隔
- `reject_if_missing`：`1` = 缺了直接出局（废标项），`0` = 只扣分
- `source`：这条规则从哪来（招标文件第几页 / 规范条款 / 专家名），**必填**
- `reviewed`：最近核对日期 `YYYY-MM-DD`，超过 12 个月会标"待复核"
- `expert_note`：写给使用者看的一句话，可留空

### evidence 的五种写法

| 写法 | 含义 | 例子 |
|---|---|---|
| `term:词` | 文中出现这个词 | `term:图纸会审` |
| `number:词` | 该词附近 30 字内必须有数字 | `number:建筑面积` |
| `section:词` | 必须提到某个图/表 | `section:平面布置图` |
| `cite:规范号` | 引用某规范（正则） | `cite:GB\s?50204` |
| `regex:正则` | 自定义正则（慎用，别写嵌套量词） | `regex:(塔吊\|塔式起重机)` |

**判定规则**：命中 0 项 = 缺失；命中 1 项 = 合格档；全中 = 最高档。
所以一条检查项最好写 2-3 项证据，档位才有区分度。

> ⚠ **字段里出现英文逗号时必须用双引号包裹整个字段**。
> 最常见的情况是正则量词：`cite:GB\s?\d{4,5}` 里的 `{4,5}` 含逗号，
> 不包裹会把一行拆成多列，校验器报“列不匹配”。正确写法：
> `"cite:GB\s?\d{4,5}；cite:GB/T\s?\d{4,5}"`
> 在 Excel 里保存时它会自动加引号，手写时才需要注意。

## tiers.csv

```
check_id,level,min_evidence,label
SG-SITE-01,1,1,合格
SG-SITE-01,2,2,良好
```

- `level`：1 低 2 中 3 高
- `min_evidence`：**至少命中几项证据**才算这一档，必须随 level 递增
- `label`：显示给用户看的档位名，用评分表里的原词（优秀/良好/合格/一般）

## 三条硬规矩（校验器会拒绝）

1. 每条 `checks.csv` 必须有 `source`，没来源的规则不许进库
2. `tiers.csv` 里同一 check 的 `min_evidence` 必须严格递增
3. `evidence` 里不许写嵌套量词正则（`(.+)+`），会把匹配卡死

## 怎么加一个新章节

1. `topics.csv` 加一行（含标题别名）
2. `checks.csv` 加 N 行
3. `tiers.csv` 加 N×档数 行
4. 跑校验，通过即生效 —— **不需要改任何代码**
