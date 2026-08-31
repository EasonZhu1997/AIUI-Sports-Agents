# Indoor Rowing Benchmark / 30

| 维度 | 分值 | 最低场景 |
|---|---:|---|
| 500m 配速准确性 | 4 | 与划船机设备屏或 FTMS 参考对照 |
| 桨频与划次 | 4 | 稳态、加速、停机、恢复；处理计数回滚 |
| 功率真实性 | 4 | SINT16、负值/无效值、字段缺失与 stale |
| 距离账本 | 4 | UINT24、首包重锚、断流不补算、真实零与不可用 |
| FTMS flags 与分片 | 5 | More Data、可选字段、截断、RFU、跨代次丢弃 |
| 首包与静默状态 | 3 | subscribed 不等于 live；记录 first-valid 和 silent |
| FTMS/HRS 双链路隔离 | 3 | 两个 generation、单路断开、hide/show、15 分钟交错 |
| 总结一致性 | 3 | active-time、字段覆盖、心率来源和本地写后读回一致 |

划船机默认只读遥测。任何启动、停止或阻力控制都必须另建 Control Point 验收轨道，且不能用 GATT write 成功代替匹配 indication。
