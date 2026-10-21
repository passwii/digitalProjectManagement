import type { Algorithm, Rule, Scene } from "@/lib/av/types";
import type { CSSProperties } from "react";
import {
  ALGORITHM_CATEGORY_LABEL,
  ALGORITHM_STATUS_LABEL,
  ALGORITHM_STATUS_TONE,
  formatCount,
  formatGb,
  formatPercent,
  sceneMeta,
  type AvTone,
} from "@/lib/av/labels";
import { AvBar, AvLegend, AvPageHeader, AvPanel, AvStatusBadge } from "@/components/av/AvUI";
import { toneVar } from "@/lib/av/tone";
import s from "./AvPages.module.css";
import type { CapabilityGroup, CapabilityProps, CapabilityScene } from "@/lib/av/contracts";

/**
 * 能力与场景：算法矩阵 + 三场景卡 + 检测规则。
 *
 * 这一页是服务端组件：数据在服务端聚合完，页面本身没有交互态（规则开关只读展示，
 * 因为 mock 数据是静态的，做成可点开关会假装写入了后端）。
 */
export default function CapabilityView({ scenes, groups, rules, chain, totals }: CapabilityProps) {
  const sceneAlarmMax = Math.max(1, ...scenes.map((scene) => scene.todayAlarms));
  const callsMax = Math.max(1, ...groups.map((group) => group.totalCalls));

  return (
    <div className={s.page} data-av-page="capability">
      <AvPageHeader
        route="/stream-monitor/capability"
        title="能力与场景"
        aside={<span className={s.headerChip}>{formatCount(totals.algorithms)} 个算法 · {formatGb(totals.vram)} 显存</span>}
      />

      <div className={s.sceneGrid}>
        {scenes.map((scene, index) => (
          <article
            key={scene.scene}
            className={s.sceneCard}
            /* 服务端组件没有 hook：错峰序号直接以内联 --av-i 交给 CSS（见 AvPages.module.css） */
            style={{ "--tone": toneVar(scene.tone), "--av-i": index } as CSSProperties}
            data-motion="scene-card"
            data-motion-key={scene.scene}
          >
            <div className={s.sceneCardHead}>
              <span className={s.sceneCode}>{scene.code}</span>
              <h3>{scene.name}</h3>
            </div>
            <p className={s.sceneSlogan}>{scene.slogan}</p>
            <ul className={s.sceneApps}>
              {scene.apps.map((app) => (
                <li key={app} className={s.sceneApp}>{app}</li>
              ))}
            </ul>
            <div className={s.sceneKpis}>
              <div>
                <strong>{formatCount(scene.points)}</strong>
                <span>点位</span>
              </div>
              <div>
                <strong>{formatCount(scene.devices)}</strong>
                <span>设备</span>
              </div>
              <div>
                <strong>{formatCount(scene.todayAlarms)}</strong>
                <span>今日告警</span>
              </div>
              <div>
                <strong>{formatCount(scene.totalAlarms)}</strong>
                <span>累计告警</span>
              </div>
            </div>
            <AvBar
              label="今日告警占比"
              value={scene.todayAlarms}
              max={sceneAlarmMax}
              tone={scene.tone}
              detail={`${formatPercent((scene.todayAlarms / Math.max(1, scenes.reduce((sum, item) => sum + item.todayAlarms, 0))) * 100, 0)}`}
            />
            <span className={s.softNote} title={scene.desc}>{scene.desc}</span>
          </article>
        ))}
      </div>

      <AvPanel
        title="多模态融合链路"
        icon="capability"
        meta={`${chain.length} 段`}
        motionKey="capability-chain"
      >
        <ol className={s.chain}>
          {chain.map((step, index) => (
            <li
              key={step.code}
              className={s.chainStep}
              data-motion="chain-step"
              data-motion-index={index}
              style={{ "--av-i": index } as CSSProperties}
            >
              <span>{step.code}</span>
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
              <small>
                {formatCount(step.count)} {step.unit}
              </small>
            </li>
          ))}
        </ol>
      </AvPanel>

      <div className={s.splitWide}>
        <AvPanel
          title="算法矩阵"
          subtitle={`${groups.length} 个类别 · 今日调用 ${formatCount(totals.callsToday)} 次 · 平均延迟 ${totals.avgLatency.toFixed(0)}ms`}
          icon="chip"
          meta={`${formatGb(totals.vram)} 显存`}
          motionKey="capability-algorithms"
        >
          {groups.map((group) => (
            <div key={group.code} className={s.algoGroup}>
              <div className={s.algoGroupHead}>
                <strong>{group.name}</strong>
                <span>
                  {group.count} 个 · 调用 {formatCount(group.totalCalls)} · 显存 {formatGb(group.totalVram)}
                </span>
              </div>
              <div className={s.algoList}>
                {group.algorithms.map((algorithm) => (
                  <div key={algorithm.id} className={s.algoCard} data-motion="algorithm" data-motion-key={algorithm.id}>
                    <div className={s.algoTop}>
                      <strong title={algorithm.name}>{algorithm.name}</strong>
                      <AvStatusBadge tone={algorithm.statusTone}>{algorithm.statusLabel}</AvStatusBadge>
                    </div>
                    <div className={s.algoMeta}>
                      <span>v{algorithm.version}</span>
                      <span>今日 {formatCount(algorithm.calls_today)}</span>
                      <span>{algorithm.avg_latency_ms}ms</span>
                      <span>{formatGb(algorithm.vram_gb)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className={s.firmwareRow}>
            <AvLegend
              items={groups.map((group) => ({
                label: ALGORITHM_CATEGORY_LABEL[group.code] ?? group.name,
                value: String(group.count),
                tone: "signal" as AvTone,
              }))}
            />
          </div>
        </AvPanel>

        <div className={s.railStack}>
          <AvPanel title="类别调用占比" icon="overview" motionKey="capability-calls">
            <div className={s.typeList}>
              {groups.map((group) => (
                <AvBar
                  key={group.code}
                  label={group.name}
                  value={group.totalCalls}
                  max={callsMax}
                  tone="violet"
                  detail={formatCount(group.totalCalls)}
                />
              ))}
            </div>
          </AvPanel>

          <AvPanel
            title="检测规则"
            subtitle="规则为只读展示，当前不可编辑"
            icon="alarm"
            meta={`${rules.filter((rule) => rule.enabled).length}/${rules.length} 启用`}
            motionKey="capability-rules"
          >
            <ul className={s.ruleList}>
              {rules.map((rule) => (
                <li key={rule.id} className={s.ruleItem} data-motion="rule" data-motion-key={rule.id}>
                  <div className={s.ruleTop}>
                    <span className={s.ruleId}>{rule.id}</span>
                    <strong className={s.ruleName}>{rule.name}</strong>
                    <AvStatusBadge tone={rule.enabled ? "success" : "neutral"}>
                      {rule.enabled ? "启用" : "停用"}
                    </AvStatusBadge>
                  </div>
                  <p className={s.ruleLine}>
                    <span>适用</span>
                    {rule.scene === "all" ? "全部场景" : sceneMeta(rule.scene).fallbackName}
                  </p>
                  <p className={s.ruleLine}>
                    <span>阈值</span>
                    {rule.threshold}
                  </p>
                  <p className={s.ruleLine}>
                    <span>动作</span>
                    {rule.action}
                  </p>
                </li>
              ))}
            </ul>
          </AvPanel>
        </div>
      </div>
    </div>
  );
}
