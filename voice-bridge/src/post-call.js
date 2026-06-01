import { writeRecordingFiles } from "./recording.js";
import { transcribeRecording } from "./transcribe.js";
import * as persist from "./persist.js";
import { generatePostCallSummary } from "./post-call-summary.js";
import { runPostCallLeadExtraction } from "./post-call-lead.js";
import { sendPostCallNotification } from "./post-call-notify.js";

export async function runPostCallProcessing(config, ctx) {
  console.log(
    `[post-call] pipeline start call_session_id=${ctx.callSessionId ?? ""} external_call_id=${ctx.externalCallId ?? ""}`
  );

  let recording = null;
  let fullTranscript = "";
  try {
    recording = await writeRecordingFiles(config, ctx);
  } catch (err) {
    console.error(`[post-call] recording failed: ${err?.message ?? String(err)}`);
    await persist.onTranscriptionFailed(config, ctx, err, { phase: "recording" });
    recording = null;
  }

  if (recording) {
    fullTranscript = (await transcribeRecording(config, ctx, recording)) || "";
  }

  try {
    const summary = await generatePostCallSummary(config, ctx, { fullTranscript });
    if (!summary?.summaryId) {
      const err = new Error("summary_not_created");
      await persist.onPostCallSummaryFailed(config, ctx, err);
      await persist.onPostCallLeadProcessed(config, ctx, {
        action: "skipped",
        reason: "summary_not_created",
        leadId: ""
      });
      await persist.onPostCallNotificationProcessed(config, ctx, {
        action: "skipped",
        reason: "summary_not_created",
        statusCode: null,
        url: config?.postCallNotify?.webhookUrl ?? "",
        error: ""
      });
      console.warn(
        `[post-call] pipeline skipped call_session_id=${ctx.callSessionId ?? ""} reason=summary_not_created`
      );
      return;
    }

    let leadResult = { action: "skipped", reason: "not_executed", leadId: "" };
    await persist.onPostCallSummaryCreated(config, ctx, summary);
    console.log(
      `[post-call] summary created summary_id=${summary.summaryId} call_session_id=${ctx.callSessionId}`
    );

    try {
      leadResult = await runPostCallLeadExtraction(config, ctx, summary);
      await persist.onPostCallLeadProcessed(config, ctx, leadResult);
      console.log(
        `[post-call] lead processed action=${leadResult?.action ?? "skipped"} reason=${leadResult?.reason ?? "unknown"} lead_id=${leadResult?.leadId ?? ""} call_session_id=${ctx.callSessionId}`
      );
    } catch (leadErr) {
      console.error(`[post-call] lead extraction failed: ${leadErr?.message ?? String(leadErr)}`);
      await persist.onPostCallLeadFailed(config, ctx, leadErr);
      await persist.onPostCallLeadProcessed(config, ctx, {
        action: "failed",
        reason: "lead_extraction_failed",
        leadId: ""
      });
      leadResult = { action: "failed", reason: "lead_extraction_failed", leadId: "" };
    }

    let notifyResult = {
      action: "skipped",
      reason: "not_executed",
      statusCode: null,
      url: "",
      error: ""
    };
    try {
      notifyResult = await sendPostCallNotification(config, ctx, summary, leadResult);
    } catch (notifyErr) {
      console.error(`[post-call] notification failed: ${notifyErr?.message ?? String(notifyErr)}`);
      notifyResult = {
        action: "failed",
        reason: "notification_exception",
        statusCode: null,
        url: config?.postCallNotify?.webhookUrl ?? "",
        error: String(notifyErr?.message ?? notifyErr ?? "notification_exception")
      };
    }
    await persist.onPostCallNotificationProcessed(config, ctx, notifyResult);
    console.log(
      `[post-call] notification processed action=${notifyResult?.action ?? "skipped"} reason=${notifyResult?.reason ?? "unknown"} status_code=${notifyResult?.statusCode ?? ""} call_session_id=${ctx.callSessionId}`
    );
    console.log(`[post-call] pipeline done call_session_id=${ctx.callSessionId ?? ""}`);
  } catch (err) {
    console.error(`[post-call] pipeline failed: ${err?.message ?? String(err)}`);
    await persist.onPostCallSummaryFailed(config, ctx, err);
    await persist.onPostCallLeadProcessed(config, ctx, {
      action: "failed",
      reason: "summary_failed",
      leadId: ""
    });
    await persist.onPostCallNotificationProcessed(config, ctx, {
      action: "failed",
      reason: "summary_failed",
      statusCode: null,
      url: config?.postCallNotify?.webhookUrl ?? "",
      error: String(err?.message ?? err ?? "summary_failed")
    });
  }
}
