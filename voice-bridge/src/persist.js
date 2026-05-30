import { randomUUID } from "node:crypto";
import * as db from "./db.js";

function safePayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const copy = { ...payload };
  for (const key of Object.keys(copy)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("password") ||
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("api_key")
    ) {
      delete copy[key];
    }
  }
  return copy;
}

function logDbError(action, err) {
  console.error(`[voice-db] ${action} failed: ${err?.message ?? String(err)}`);
}

function safeErrorMessage(err) {
  return String(err?.message ?? err ?? "unknown error").slice(0, 500);
}

function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw.replace(/[^\d+]/g, "");
  if (!compact) return "";
  return compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
}

function safePreview(config, text) {
  if (config.assistant?.logTranscriptPreview) {
    return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return "<redacted>";
}

/**
 * Unique per TCP call — do not use Asterisk AudioSocket UUID as external_call_id
 * (production dialplan may send a static placeholder UUID).
 */
export function assignBridgeCallIdentity(ctx) {
  ctx.bridgeCallId = randomUUID();
  ctx.externalCallId = `bridge:${ctx.bridgeCallId}`;
  return ctx.externalCallId;
}

export function callLogLabel(ctx) {
  const bridge = ctx.bridgeCallId ?? "pending";
  const as = ctx.audiosocketUuid ?? "pending";
  return `bridge_call_id=${bridge} audiosocket_uuid=${as}`;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export async function onConnectionOpen(config, ctx) {
  if (!db.isDbConfigured(config)) {
    console.warn("[voice-db] persistence disabled (VOICE_DB_USER / VOICE_DB_PASSWORD not set)");
    return;
  }

  try {
    const id = await db.createCallSession(config, {
      externalCallId: ctx.externalCallId,
      source: "easybell",
      provider: "easybell",
      direction: "inbound",
      status: "active",
      callerPhoneRaw: ctx.callerPhoneRaw || "",
      callerPhoneNormalized: normalizePhone(ctx.callerPhoneNormalized || ctx.callerPhoneRaw || ""),
      language: "de",
      metadata: safePayload({
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid,
        bridge_version: config.bridgeVersion,
        initial_remote_address: ctx.remoteAddress,
        greeting_mode: config.greetingMode,
        caller_phone_raw: ctx.callerPhoneRaw || "",
        caller_phone_normalized: normalizePhone(ctx.callerPhoneNormalized || ctx.callerPhoneRaw || ""),
        caller_phone_source: ctx.callerPhoneSource || ""
      })
    });
    if (id) {
      ctx.callSessionId = id;
      console.log(
        `[voice-db] call session created id=${id} external_call_id=${ctx.externalCallId} ${callLogLabel(ctx)}`
      );
    }
  } catch (err) {
    logDbError("createCallSession", err);
  }
}

export async function onCallStarted(config, ctx) {
  if (!ctx.callSessionId) return;
  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "call_started",
      payload: safePayload({
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid,
        external_call_id: ctx.externalCallId,
        remote_address: ctx.remoteAddress,
        caller_phone_raw: ctx.callerPhoneRaw || "",
        caller_phone_normalized: normalizePhone(ctx.callerPhoneNormalized || ctx.callerPhoneRaw || ""),
        caller_phone_source: ctx.callerPhoneSource || ""
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(call_started)", err);
  }
}

export async function onGreetingPlayed(config, ctx, greetingInfo = {}) {
  if (!ctx.callSessionId) return;
  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "greeting_played",
      payload: safePayload({
        greeting_mode: config.greetingMode,
        greeting_file: greetingInfo.greetingFile || "",
        greeting_type: greetingInfo.greetingType || config.greetingMode,
        greeting_source: greetingInfo.greetingSource ?? greetingInfo.greeting_source ?? "",
        fallback_reason: greetingInfo.fallbackReason || "",
        requested_file: greetingInfo.requestedFile || ""
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(greeting_played)", err);
  }
}

export async function onGreetingSkipped(config, ctx, info = {}) {
  if (!ctx.callSessionId) return;
  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "greeting_skipped",
      payload: safePayload({
        greeting_mode: config.greetingMode,
        greeting_file: info.greeting_file ?? info.greetingFile ?? "",
        reason: info.reason ?? "unknown"
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(greeting_skipped)", err);
  }
}

export async function onTranscriptCreated(config, ctx, info = {}) {
  if (!ctx.callSessionId) return false;

  try {
    await db.insertCallTranscript(config, {
      callSessionId: ctx.callSessionId,
      speaker: info.speaker ?? "caller",
      text: info.text,
      sequenceNumber: info.sequenceNumber ?? 1,
      isFinal: true,
      confidence: null,
      language: info.language,
      metadata: safePayload({
        model: info.model,
        language: info.language,
        recording_wav_path: info.recordingWavPath,
        recording_slin_path: info.recordingSlinPath,
        audio_bytes: info.audioBytes,
        transcript_scope: info.transcriptScope ?? "full_call",
        turn_index: info.turnIndex ?? null,
        detected_intent: info.detectedIntent ?? null,
        transcript_quality: info.transcriptQuality ?? null,
        transcript_quality_reason: info.transcriptQualityReason ?? null,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError("insertCallTranscript", err);
    return false;
  }

  if (info.emitTranscriptEvent !== false) {
    try {
      await db.insertCallEvent(config, {
        callSessionId: ctx.callSessionId,
        eventType: "transcript_created",
        payload: safePayload({
          model: info.model,
          language: info.language,
          transcript_length: String(info.text ?? "").length,
          transcript_scope: info.transcriptScope ?? "full_call",
          turn_index: info.turnIndex ?? null,
          recording_wav_path: info.recordingWavPath,
          bridge_call_id: ctx.bridgeCallId,
          audiosocket_uuid: ctx.audiosocketUuid
        })
      });
    } catch (err) {
      logDbError("insertCallEvent(transcript_created)", err);
    }
  }

  return true;
}

export async function onTurnTranscribed(config, ctx, info = {}) {
  if (!ctx.callSessionId) return false;

  const persisted = await onTranscriptCreated(config, ctx, {
    ...info,
      speaker: "caller",
      sequenceNumber: info.sequenceNumber ?? Math.max(1, (Number(info.turnIndex ?? 1) * 2) - 1),
      transcriptScope: "turn",
      emitTranscriptEvent: false
    });
  if (!persisted) return false;

  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "turn_transcribed",
      payload: safePayload({
        model: info.model,
        language: info.language,
        transcript_length: String(info.text ?? "").length,
        caller_transcript_preview: safePreview(config, info.text),
        detected_intent: info.detectedIntent ?? "unknown",
        transcript_quality: info.transcriptQuality ?? "unknown",
        transcript_quality_reason: info.transcriptQualityReason ?? "",
        turn_index: info.turnIndex ?? 1,
        sequence_number: info.sequenceNumber ?? Math.max(1, (Number(info.turnIndex ?? 1) * 2) - 1),
        recording_wav_path: info.recordingWavPath ?? "",
        listen_duration_ms: info.timings?.listenDurationMs ?? null,
        speech_end_detected: info.timings?.speechEndDetected ?? null,
        audio_bytes_captured: info.timings?.audioBytesCaptured ?? info.audioBytes ?? null,
        transcription_ms: info.timings?.transcriptionMs ?? null,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(turn_transcribed)", err);
  }

  return true;
}

export async function onAssistantResponseCreated(config, ctx, info = {}) {
  if (!ctx.callSessionId) return false;

  try {
    await db.insertCallTranscript(config, {
      callSessionId: ctx.callSessionId,
      speaker: "assistant",
      text: info.text,
      sequenceNumber: info.sequenceNumber ?? 2,
      isFinal: true,
      confidence: null,
      language: info.language ?? "de",
      metadata: safePayload({
        model: info.model,
        assistant_model: info.assistantModel ?? info.model,
        knowledge_file: info.knowledgeFile ?? "",
        knowledge_source: info.knowledgeSource ?? info.knowledgeFile ?? "",
        knowledge_version: info.knowledgeVersion ?? "",
        response_chars: info.responseChars ?? String(info.text ?? "").length,
        detected_intent: info.detectedIntent ?? "unknown",
        transcript_quality: info.transcriptQuality ?? "unknown",
        transcript_quality_reason: info.transcriptQualityReason ?? "",
        used_template_response: Boolean(info.usedTemplateResponse),
        used_llm_response: Boolean(info.usedLlmResponse),
        used_clarification_fallback: Boolean(info.usedClarificationFallback),
        used_relevance_fallback: Boolean(info.usedRelevanceFallback),
        handoff_requested: Boolean(info.handoffRequested),
        callback_requested: Boolean(info.callbackRequested),
        contact_preference_asked: Boolean(info.contactPreferenceAsked),
        contact_preference_detected: info.contactPreference ?? null,
        contact_route: info.contactRoute ?? null,
        contact_permission_requested: Boolean(info.contactPermissionRequested),
        contact_permission_granted:
          typeof info.contactPermissionGranted === "boolean" ? info.contactPermissionGranted : null,
        permission_detected: info.permissionDetected ?? null,
        permission_detection_source: info.permissionDetectionSource ?? null,
        permission_retry_count: Number(info.permissionRetryCount ?? 0),
        contact_detail_attempted: Boolean(info.contactDetailAttempted),
        contact_detail_retry_count: Number(info.contactDetailRetryCount ?? 0),
        contact_detail_type: info.contactDetailType ?? null,
        contact_detail_source: info.contactDetailSource ?? null,
        contact_detail_valid: Boolean(info.contactDetailValid),
        email_direct_offered: Boolean(info.emailDirectOffered),
        soft_intake_lead_created: Boolean(info.softIntakeLeadCreated),
        soft_intake_waiting_for: info.softIntakeWaitingFor ?? null,
        soft_intake_completed: Boolean(info.softIntakeCompleted),
        closing_pending: Boolean(info.closingPending),
        final_question_asked: Boolean(info.finalQuestionAsked),
        final_goodbye_sent: Boolean(info.finalGoodbyeSent),
        max_turns_extended_for_intake: Boolean(info.maxTurnsExtendedForIntake),
        max_turns_blocked_by_active_intake: Boolean(info.maxTurnsBlockedByActiveIntake),
        max_turns_blocked_by_permission_state: Boolean(info.maxTurnsBlockedByPermissionState),
        soft_intake_failed_reason: info.softIntakeFailedReason ?? null,
        soft_intake_state: info.softIntakeState ?? "",
        product_flow_state: info.productFlowState ?? "",
        product_overview_offered: Boolean(info.productOverviewOffered),
        product_awaiting_selection: Boolean(info.productAwaitingSelection),
        product_awaiting_interest_confirmation: Boolean(info.productAwaitingInterestConfirmation),
        product_interest: info.productInterest ?? null,
        product_interest_name: info.productInterestName ?? null,
        customer_type: info.customerType ?? null,
        sales_stage: info.salesStage ?? null,
        sales_need_captured: Boolean(info.salesNeedCaptured),
        current_problem: info.currentProblem ?? "",
        desired_outcome: info.desiredOutcome ?? "",
        product_last_intent: info.productLastIntent ?? null,
        transcript_scope: "turn",
        turn_index: info.turnIndex ?? 1,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError("insertCallTranscript(assistant)", err);
    return false;
  }

  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "assistant_response_created",
      payload: safePayload({
        model: info.model,
        language: info.language ?? "de",
        response_length: String(info.text ?? "").length,
        response_chars: info.responseChars ?? String(info.text ?? "").length,
        used_llm_response: Boolean(info.usedLlmResponse),
        detected_intent: info.detectedIntent ?? "unknown",
        transcript_quality: info.transcriptQuality ?? "unknown",
        transcript_quality_reason: info.transcriptQualityReason ?? "",
        used_template_response: Boolean(info.usedTemplateResponse),
        used_clarification_fallback: Boolean(info.usedClarificationFallback),
        used_relevance_fallback: Boolean(info.usedRelevanceFallback),
        handoff_requested: Boolean(info.handoffRequested),
        callback_requested: Boolean(info.callbackRequested),
        contact_preference_asked: Boolean(info.contactPreferenceAsked),
        contact_preference_detected: info.contactPreference ?? null,
        contact_route: info.contactRoute ?? null,
        contact_permission_requested: Boolean(info.contactPermissionRequested),
        contact_permission_granted:
          typeof info.contactPermissionGranted === "boolean" ? info.contactPermissionGranted : null,
        permission_detected: info.permissionDetected ?? null,
        permission_detection_source: info.permissionDetectionSource ?? null,
        permission_retry_count: Number(info.permissionRetryCount ?? 0),
        contact_detail_attempted: Boolean(info.contactDetailAttempted),
        contact_detail_retry_count: Number(info.contactDetailRetryCount ?? 0),
        contact_detail_type: info.contactDetailType ?? null,
        contact_detail_valid: Boolean(info.contactDetailValid),
        email_direct_offered: Boolean(info.emailDirectOffered),
        soft_intake_lead_created: Boolean(info.softIntakeLeadCreated),
        soft_intake_waiting_for: info.softIntakeWaitingFor ?? null,
        soft_intake_completed: Boolean(info.softIntakeCompleted),
        closing_pending: Boolean(info.closingPending),
        final_question_asked: Boolean(info.finalQuestionAsked),
        final_goodbye_sent: Boolean(info.finalGoodbyeSent),
        max_turns_extended_for_intake: Boolean(info.maxTurnsExtendedForIntake),
        max_turns_blocked_by_active_intake: Boolean(info.maxTurnsBlockedByActiveIntake),
        max_turns_blocked_by_permission_state: Boolean(info.maxTurnsBlockedByPermissionState),
        soft_intake_failed_reason: info.softIntakeFailedReason ?? null,
        soft_intake_state: info.softIntakeState ?? "",
        product_flow_state: info.productFlowState ?? "",
        product_overview_offered: Boolean(info.productOverviewOffered),
        product_awaiting_selection: Boolean(info.productAwaitingSelection),
        product_awaiting_interest_confirmation: Boolean(info.productAwaitingInterestConfirmation),
        product_interest: info.productInterest ?? null,
        product_interest_name: info.productInterestName ?? null,
        customer_type: info.customerType ?? null,
        sales_stage: info.salesStage ?? null,
        sales_need_captured: Boolean(info.salesNeedCaptured),
        current_problem: info.currentProblem ?? "",
        desired_outcome: info.desiredOutcome ?? "",
        product_last_intent: info.productLastIntent ?? null,
        assistant_response_preview: safePreview(config, info.text),
        knowledge_source: info.knowledgeSource ?? info.knowledgeFile ?? "",
        knowledge_version: info.knowledgeVersion ?? "",
        turn_index: info.turnIndex ?? 1,
        sequence_number: info.sequenceNumber ?? Number(info.turnIndex ?? 1) * 2,
        response_generation_ms: info.timings?.responseGenerationMs ?? null,
        listen_duration_ms: info.timings?.listenDurationMs ?? null,
        speech_end_detected: info.timings?.speechEndDetected ?? null,
        audio_bytes_captured: info.timings?.audioBytesCaptured ?? null,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(assistant_response_created)", err);
  }

  return true;
}

export async function onAssistantResponsePlayed(config, ctx, info = {}) {
  if (!ctx.callSessionId) return;

  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "assistant_response_played",
      payload: safePayload({
        tts_model: info.ttsModel ?? config.assistant?.ttsModel ?? "",
        tts_voice: info.ttsVoice ?? config.assistant?.ttsVoice ?? "",
        frames: info.frames ?? 0,
        bytes: info.bytes ?? 0,
        audio_file: info.audioFile ?? "",
        turn_index: info.turnIndex ?? 1,
        playback_ms: info.timings?.playbackMs ?? null,
        speech_end_detected: info.timings?.speechEndDetected ?? null,
        audio_bytes_captured: info.timings?.audioBytesCaptured ?? null,
        tts_ms: info.timings?.ttsMs ?? null,
        total_turn_ms: info.timings?.totalTurnMs ?? null,
        listen_duration_ms: info.timings?.listenDurationMs ?? null,
        transcription_ms: info.timings?.transcriptionMs ?? null,
        response_generation_ms: info.timings?.responseGenerationMs ?? null,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(assistant_response_played)", err);
  }
}

export async function onSoftIntakeEvent(config, ctx, eventType, info = {}) {
  if (!ctx.callSessionId) return;

  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType,
      payload: safePayload({
        turn_index: info.turnIndex ?? null,
        detected_intent: info.detectedIntent ?? "unknown",
        handoff_requested: Boolean(info.handoffRequested),
        callback_requested: Boolean(info.callbackRequested),
        contact_preference_asked: Boolean(info.contactPreferenceAsked),
        contact_preference_detected: info.contactPreference ?? null,
        contact_route: info.contactRoute ?? null,
        contact_permission_requested: Boolean(info.contactPermissionRequested),
        contact_permission_granted:
          typeof info.contactPermissionGranted === "boolean" ? info.contactPermissionGranted : null,
        permission_detected: info.permissionDetected ?? null,
        permission_detection_source: info.permissionDetectionSource ?? null,
        permission_retry_count: Number(info.permissionRetryCount ?? 0),
        contact_detail_attempted: Boolean(info.contactDetailAttempted),
        contact_detail_retry_count: Number(info.contactDetailRetryCount ?? 0),
        contact_detail_type: info.contactDetailType ?? null,
        email_direct_offered: Boolean(info.emailDirectOffered),
        soft_intake_lead_created: Boolean(info.softIntakeLeadCreated),
        soft_intake_waiting_for: info.softIntakeWaitingFor ?? null,
        soft_intake_completed: Boolean(info.softIntakeCompleted),
        closing_pending: Boolean(info.closingPending),
        final_question_asked: Boolean(info.finalQuestionAsked),
        final_goodbye_sent: Boolean(info.finalGoodbyeSent),
        max_turns_extended_for_intake: Boolean(info.maxTurnsExtendedForIntake),
        max_turns_blocked_by_active_intake: Boolean(info.maxTurnsBlockedByActiveIntake),
        max_turns_blocked_by_permission_state: Boolean(info.maxTurnsBlockedByPermissionState),
        soft_intake_failed_reason: info.softIntakeFailedReason ?? null,
        soft_intake_state: info.softIntakeState ?? "",
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError(`insertCallEvent(${eventType})`, err);
  }
}

export async function onSoftIntakeLeadReady(config, ctx, info = {}) {
  if (!ctx.callSessionId) return null;
  if (ctx.softIntakeLeadId) return ctx.softIntakeLeadId;

  try {
    const product = ctx?.assistantTurn?.product && typeof ctx.assistantTurn.product === "object"
      ? ctx.assistantTurn.product
      : {};
    const salesContext = product.salesContext && typeof product.salesContext === "object"
      ? product.salesContext
      : {};
    const leadId = await db.insertVoiceLead(config, {
      callSessionId: ctx.callSessionId,
      normalizedPhone: info.normalizedPhone ?? "",
      status: "new",
      source: "voice",
      notes: info.notes ?? "Voice assistant reception-first intake.",
      metadata: safePayload({
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid,
        intake_mode: "reception_first",
        contact_route: info.contactRoute ?? "",
        contact_preference: info.contactPreference ?? "",
        contact_permission_granted:
          typeof info.contactPermissionGranted === "boolean" ? info.contactPermissionGranted : null,
        contact_detail_source: info.contactDetailSource ?? null,
        email_direct_to: info.emailDirectTo ?? "",
        detected_intent: info.detectedIntent ?? "unknown",
        turn_index: info.turnIndex ?? null,
        lead_capture_scope: "soft_intake_milestone",
        product_interest: product.selectedProduct ?? null,
        product_interest_name: product.selectedProductName ?? null,
        customer_type: product.customerType ?? null,
        sales_stage: product.productDialogueState ?? null,
        sales_need_captured: Boolean(product.salesNeedCaptured),
        current_problem: salesContext.current_problem ?? "",
        desired_outcome: salesContext.desired_outcome ?? "",
        no_voice_email_capture: Boolean(info.noVoiceEmailCapture),
        caller_id_assumed: false,
        caller_phone_raw: ctx.callerPhoneRaw || "",
        caller_phone_normalized: normalizePhone(ctx.callerPhoneNormalized || ctx.callerPhoneRaw || "")
      })
    });

    if (leadId) {
      ctx.softIntakeLeadId = leadId;
      await db.insertCallEvent(config, {
        callSessionId: ctx.callSessionId,
        eventType: "soft_intake_lead_created",
        payload: safePayload({
          lead_id: leadId,
          contact_route: info.contactRoute ?? "",
          contact_preference: info.contactPreference ?? "",
          email_direct_to: info.emailDirectTo ?? "",
          has_normalized_phone: Boolean(info.normalizedPhone),
          contact_detail_source: info.contactDetailSource ?? null,
          no_voice_email_capture: Boolean(info.noVoiceEmailCapture),
          bridge_call_id: ctx.bridgeCallId,
          audiosocket_uuid: ctx.audiosocketUuid
        })
      });
    }
    return leadId;
  } catch (err) {
    logDbError("insertVoiceLead(soft_intake)", err);
    return null;
  }
}

export async function onTurnFailed(config, ctx, err, info = {}) {
  const message = safeErrorMessage(err);
  console.warn(`[voice-assistant] turn failed reason=${message}`);

  if (!ctx.callSessionId) return;

  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "turn_failed",
      payload: safePayload({
        reason: message,
        phase: info.phase ?? "turn",
        turn_index: info.turnIndex ?? 1,
        listen_duration_ms: info.timings?.listenDurationMs ?? null,
        transcription_ms: info.timings?.transcriptionMs ?? null,
        response_generation_ms: info.timings?.responseGenerationMs ?? null,
        tts_ms: info.timings?.ttsMs ?? null,
        playback_ms: info.timings?.playbackMs ?? null,
        total_turn_ms: info.timings?.totalTurnMs ?? null,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (dbErr) {
    logDbError("insertCallEvent(turn_failed)", dbErr);
  }
}

export async function onConversationFinished(config, ctx, info = {}) {
  if (!ctx.callSessionId) return;

  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "conversation_finished",
      payload: safePayload({
        reason: info.reason ?? "unknown",
        turns_completed: info.turnsCompleted ?? 0,
        max_turns: config.assistant?.maxTurns ?? 0,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(conversation_finished)", err);
  }
}

export async function onTranscriptionFailed(config, ctx, err, info = {}) {
  const message = safeErrorMessage(err);
  console.warn(`[voice-transcribe] transcription failed reason=${message}`);

  if (!ctx.callSessionId) return;

  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "transcription_failed",
      payload: safePayload({
        reason: message,
        phase: info.phase ?? "transcription",
        model: info.model ?? config.transcription?.model ?? "",
        language: info.language ?? config.transcription?.language ?? "",
        recording_wav_path: info.recordingWavPath ?? "",
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (dbErr) {
    logDbError("insertCallEvent(transcription_failed)", dbErr);
  }
}

export async function onCallEnded(config, ctx, endInfo = {}) {
  if (!ctx.callSessionId) return;

  const durationSeconds =
    typeof endInfo.durationSeconds === "number" && endInfo.durationSeconds >= 0
      ? Math.floor(endInfo.durationSeconds)
      : ctx.startedAt
        ? Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000))
        : null;

  try {
    await db.endCallSession(config, {
      callSessionId: ctx.callSessionId,
      status: endInfo.status ?? "completed",
      durationSeconds,
      metadataPatch: safePayload({
        close_reason: endInfo.closeReason ?? "socket_close",
        frames_received: endInfo.framesReceived ?? ctx.framesReceived ?? 0,
        bytes_received: endInfo.bytesReceived ?? ctx.bytesReceived ?? 0
      })
    });
  } catch (err) {
    logDbError("endCallSession", err);
  }

  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "call_ended",
      payload: safePayload({
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid,
        close_reason: endInfo.closeReason ?? "socket_close",
        frames: endInfo.framesReceived ?? ctx.framesReceived ?? 0,
        bytes: endInfo.bytesReceived ?? ctx.bytesReceived ?? 0,
        duration_seconds: durationSeconds
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(call_ended)", err);
  }
}

export async function onPostCallSummaryCreated(config, ctx, summary = {}) {
  if (!ctx.callSessionId) return;
  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "post_call_summary_created",
      payload: safePayload({
        summary_id: summary.summaryId ?? "",
        summary_type: "auto",
        model: "deterministic-post-call-v1",
        summary_preview: safePreview(config, summary.summaryText ?? ""),
        product_interest: summary.metadata?.product_interest ?? null,
        contact_preference: summary.metadata?.contact_preference ?? null,
        permission: summary.metadata?.permission ?? null,
        next_action: summary.metadata?.next_action ?? null,
        confidence: summary.metadata?.confidence ?? null,
        transcript_quality_notes: summary.metadata?.transcript_quality_notes ?? null,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(post_call_summary_created)", err);
  }
}

export async function onPostCallSummaryFailed(config, ctx, err) {
  if (!ctx.callSessionId) return;
  const message = safeErrorMessage(err);
  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "post_call_summary_failed",
      payload: safePayload({
        reason: message,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (dbErr) {
    logDbError("insertCallEvent(post_call_summary_failed)", dbErr);
  }
}

export async function onPostCallLeadProcessed(config, ctx, info = {}) {
  if (!ctx.callSessionId) return;
  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "post_call_lead_processed",
      payload: safePayload({
        action: info.action ?? "skipped",
        reason: info.reason ?? "unknown",
        lead_id: info.leadId ?? "",
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(post_call_lead_processed)", err);
  }
}

export async function onPostCallLeadFailed(config, ctx, err) {
  if (!ctx.callSessionId) return;
  const message = safeErrorMessage(err);
  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "post_call_lead_failed",
      payload: safePayload({
        reason: message,
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (dbErr) {
    logDbError("insertCallEvent(post_call_lead_failed)", dbErr);
  }
}

export async function onPostCallNotificationProcessed(config, ctx, info = {}) {
  if (!ctx.callSessionId) return;
  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "post_call_notification_processed",
      payload: safePayload({
        action: info.action ?? "skipped",
        reason: info.reason ?? "unknown",
        status_code: info.statusCode ?? null,
        url: info.url ?? "",
        error: info.error ?? "",
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (err) {
    logDbError("insertCallEvent(post_call_notification_processed)", err);
  }
}

export async function onError(config, ctx, err, extra = {}) {
  const message = err?.message ?? String(err);
  console.error(`[voice-bridge] error: ${message} ${callLogLabel(ctx)}`);

  if (!ctx.callSessionId || !db.isDbConfigured(config)) return;

  try {
    await db.insertCallEvent(config, {
      callSessionId: ctx.callSessionId,
      eventType: "error",
      payload: safePayload({
        message,
        phase: extra.phase ?? "unknown",
        bridge_call_id: ctx.bridgeCallId,
        audiosocket_uuid: ctx.audiosocketUuid
      })
    });
  } catch (dbErr) {
    logDbError("insertCallEvent(error)", dbErr);
  }
}

export async function shutdownDb(config) {
  await db.closePool();
}
