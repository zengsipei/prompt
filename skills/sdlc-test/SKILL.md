---
name: sdlc-test
description: SDLC 测试：用户要验证或测试本次改动风险面时使用。
---

# sdlc-test

测试阶段：覆盖本次改动的风险面，不求大而全。

```bash
sdlc-hook phase.set --phase test
```

## 步骤

1. 用抽象步骤 `run-tests` 取测试工具链；本地执行单元 / 冒烟 / 功能测试，**绝不接 CI 或人工外包**。
2. 记录：lite/standard 合并到 `onlyAI/verification.md`；full 拆 `004-测试用例.md` + `005-测试报告.md` + verification。
3. 覆盖正常流程、边界条件、错误恢复；无法执行的测试标注原因与风险评估。连续 3 次失败暂停重估。

完成判据：本 profile 的验证产物齐全，本次改动的风险面有明确结论。
