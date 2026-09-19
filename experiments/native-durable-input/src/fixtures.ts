/** Fixed text shared by Process A and Process B so both sides agree without duplicating literals. */

export const QUESTION_SYSTEM_PROMPT = "You are a scripted research agent used for the M1.12 durable-input proof.";
export const QUESTION_TEXT = "Should I proceed with the plan as described?";
export const QUESTION_INPUT = "Please help with this task; ask me first if you need anything.";
export const QUESTION_FINAL_REPLY = "Thanks -- proceeding now that you've answered.";

export const RESTART_NOTE = "about to run the risky step";
export const RESTART_INPUT = "Run the restart-probe step.";
export const RESTART_FINAL_REPLY = "Restart probe step complete.";

export const PROCESS_DEATH_LABEL = "wait-for-flag";
export const PROCESS_DEATH_INPUT = "Run the long blocking step.";
export const PROCESS_DEATH_SYSTEM_PROMPT = "You are a scripted research agent used for the M1.12 process-death proof.";
export const PROCESS_DEATH_FINAL_REPLY = "Blocking step complete.";
