import type { AgentInfo } from "./types.ts";

const SKILL_PATH = /(?:^|[\\/])(?:[\w.-]+-skills?|My Skills)(?:[\\/]|$)|[\\/]\.(?:claude|codex|agents|gemini[\\/]config)[\\/]skills(?:[\\/]|$)|[\\/]Claude[\\/]skills(?:[\\/]|$)|(?:^|[\\/])SKILL\.md$/i;

export function isSkillPath(path: string): boolean {
  return SKILL_PATH.test(path);
}

export function trainingFocus(agent: Pick<AgentInfo, "cwd" | "files">): string | null {
  const latest = [...(agent.files ?? [])].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (latest) return isSkillPath(latest.path) ? latest.path : null;
  return agent.cwd && isSkillPath(agent.cwd) ? agent.cwd : null;
}

export const TRAINING_STAGES = [
  { stage: "lecture", duration: 12, label: "Giảng bài" },
  { stage: "demonstrate", duration: 10, label: "Hướng dẫn trên bảng" },
  { stage: "notes", duration: 11, label: "Ghi chép" },
  { stage: "practice", duration: 14, label: "Thực hành" },
  { stage: "question", duration: 6, label: "Học viên đặt câu hỏi" },
  { stage: "answer", duration: 8, label: "Giải đáp" },
  { stage: "recap", duration: 7, label: "Ôn lại bài" },
] as const;

export const TRAINING_CYCLE_SECONDS = TRAINING_STAGES.reduce((sum, step) => sum + step.duration, 0);
export type TrainingAction = "explain" | "point" | "observe" | "invite" | "answer" | "listen" | "write" | "type" | "read" | "raise" | "ask" | "nod";

export interface TrainingMember {
  id: string;
  seat: number | "host";
  x: number;
  z: number;
}

export interface TrainingCue {
  action: TrainingAction;
  teacher: boolean;
  lookAt: { x: number; z: number } | null;
  speaking: boolean;
  time: number;
}

export function sampleTraining(elapsed: number) {
  const seconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const cycle = Math.floor(seconds / TRAINING_CYCLE_SECONDS);
  let time = seconds % TRAINING_CYCLE_SECONDS;
  for (let index = 0; index < TRAINING_STAGES.length; index++) {
    const entry = TRAINING_STAGES[index];
    if (time < entry.duration || index === TRAINING_STAGES.length - 1) return { ...entry, time, cycle, index };
    time -= entry.duration;
  }
  return { ...TRAINING_STAGES[0], time: 0, cycle, index: 0 };
}

export class TrainingDirector {
  private questionCycle = -1;
  private questioner: string | null = null;

  cues(members: TrainingMember[], elapsed: number, quiet = false): Map<string, TrainingCue> {
    const lesson = sampleTraining(quiet ? 0 : elapsed);
    const teacher = members.find((member) => member.seat === "host");
    const learners = members.filter((member) => typeof member.seat === "number").sort((a, b) => Number(a.seat) - Number(b.seat));
    const discussion = lesson.stage === "question" || lesson.stage === "answer";
    if (discussion && lesson.cycle !== this.questionCycle) {
      this.questionCycle = lesson.cycle;
      this.questioner = learners.length && teacher ? learners[lesson.cycle % learners.length].id : null;
    }
    const speaker = discussion ? learners.find((member) => member.id === this.questioner) : undefined;
    const out = new Map<string, TrainingCue>();
    for (const member of members) {
      const host = member === teacher;
      const offset = typeof member.seat === "number" ? member.seat * 0.73 : 0;
      const beat = (lesson.time + offset) % 9;
      let action: TrainingAction = host ? "explain" : "listen";
      let lookAt: TrainingCue["lookAt"] = host ? learners[Math.floor(lesson.time / 4) % Math.max(1, learners.length)] ?? null : teacher ?? null;
      if (host) {
        if (lesson.stage === "demonstrate") action = "point";
        if (lesson.stage === "notes" || lesson.stage === "practice") action = "observe";
        if (lesson.stage === "question") action = speaker && lesson.time >= 2 ? "listen" : "invite";
        if (lesson.stage === "answer") action = speaker ? "answer" : "explain";
        if (discussion && speaker) lookAt = speaker;
      } else {
        if (lesson.stage === "lecture" && beat > 5.8) action = "write";
        if (lesson.stage === "notes") action = beat < 6.8 ? "write" : "read";
        if (lesson.stage === "practice") action = beat < 6.5 ? "type" : "read";
        if (lesson.stage === "recap") action = beat < 4 ? "nod" : "write";
        if (member === speaker && teacher) {
          if (lesson.stage === "question") action = lesson.time < 2 ? "raise" : "ask";
          if (lesson.stage === "answer") action = lesson.time < 5 ? "listen" : "nod";
        }
        if (lesson.stage === "question" && lesson.time >= 2 && speaker && member !== speaker) lookAt = speaker;
      }
      if (quiet) action = host ? "explain" : "listen";
      const speaking = !quiet && (action === "explain" || action === "point" || action === "invite" || action === "answer" || action === "ask");
      out.set(member.id, { action, teacher: host, lookAt, speaking, time: quiet ? 0 : lesson.time });
    }
    return out;
  }
}
