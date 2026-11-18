// The patient report a doctor downloads from the report assistant (or the patient record): health details,
// the summary, visits, prescriptions, uploaded reports and saved symptom checks, as a PDF.
import { createPdf, wrapText } from "./pdf.js";
import { BLUE, GREY, clock, day, footer, header, pair, slotDay } from "./receipts.js";

const LEFT = 48;
const BOTTOM = 770;
const NOTE = "Confidential: for the treating doctor. Made by Medora from the patient's record; an AI summary can contain mistakes.";
const URGENCY = { emergency: "Emergency", soon: "See a doctor soon", routine: "Routine", self_care: "Self-care" };

const list = items => (items?.length ? items.join(", ") : "None recorded");

export const patientReportPdf = ({ doctor, report, madeAt = new Date() }) => {
  const pdf = createPdf();
  const width = pdf.width - LEFT * 2;
  const sections = new Set(report.sections);
  let y = 0;
  let pages = 1;

  header(pdf, "Patient report", `${report.period} · made ${day(madeAt)}`);
  y = 130;

  const newPage = () => {
    footer(pdf, `${NOTE} Page ${pages}.`);
    pdf.addPage();
    pages++;
    y = 60;
  };
  const ensure = space => {
    if (y + space > BOTTOM) newPage();
  };
  const heading = title => {
    ensure(48);
    y += 18;
    pdf.text(title.toUpperCase(), LEFT, y, { size: 9, bold: true, color: BLUE });
    pdf.line(LEFT, y + 6, LEFT + width, y + 6);
    y += 24;
  };
  const paragraph = (text, { size = 10, bold = false, color, indent = 0, gap = 4 } = {}) => {
    for (const line of wrapText(text, size, width - indent, bold)) {
      ensure(size + gap);
      pdf.text(line, LEFT + indent, y, { size, bold, ...(color && { color }) });
      y += size + gap;
    }
  };
  const empty = text => paragraph(text, { color: GREY, size: 9.5 });

  // who
  const { patient } = report;
  pair(pdf, "Patient", `${patient.name}${patient.relation ? ` (${patient.relation} of ${patient.bookedBy})` : ""}`, LEFT, y);
  pair(pdf, "Doctor", `${doctor?.name || "Doctor"}${doctor?.specialization ? `, ${doctor.specialization}` : ""}`, 310, y);
  y += 46;
  pair(pdf, "Age / sex", [patient.age != null ? `${patient.age} years` : "Age not recorded", patient.gender].filter(Boolean).join(", "), LEFT, y);
  pair(pdf, "Blood type / BMI", [patient.bloodType || "Blood type not recorded", patient.bmi && `BMI ${patient.bmi}`].filter(Boolean).join(" · "), 310, y);
  y += 36;

  // summary
  if (report.summary) {
    heading(report.summarySource === "ai" ? "Summary (AI, check against the record)" : "Summary (from the record)");
    report.summary.lines.forEach(line => paragraph(`- ${line}`));
    if (report.summary.watchOuts?.length) {
      y += 4;
      paragraph("Watch out for", { size: 9, bold: true, color: GREY });
      report.summary.watchOuts.forEach(item => paragraph(`- ${item}`));
    }
    if (report.summary.askAbout?.length) {
      y += 4;
      paragraph("Ask about", { size: 9, bold: true, color: GREY });
      report.summary.askAbout.forEach(item => paragraph(`- ${item}`));
    }
  }

  if (sections.has("health")) {
    heading("Health details");
    paragraph(`Allergies: ${list(patient.allergies)}`);
    paragraph(`Conditions: ${list(patient.conditions)}`);
    paragraph(`Current medicines: ${list(patient.medications)}`);
  }

  if (sections.has("visits")) {
    heading(`Visits with you (${report.visits.length})`);
    if (!report.visits.length) empty("No visits in this period.");
    report.visits.forEach(visit => {
      ensure(16);
      pdf.text(`${slotDay(visit.date)}, ${clock(visit.time)}`, LEFT, y, { size: 10, bold: true });
      pdf.text(`${visit.type} · ${visit.status}`, 230, y, { size: 10 });
      y += 14;
      if (visit.complaint) paragraph(`Told us before the visit: ${visit.complaint}`, { size: 9.5, color: GREY, indent: 12 });
      y += 2;
    });
  }

  if (sections.has("prescriptions")) {
    heading(`Prescriptions you wrote (${report.prescriptions.length})`);
    if (!report.prescriptions.length) empty("No prescriptions in this period.");
    report.prescriptions.forEach(item => {
      ensure(30);
      paragraph(`${slotDay(item.date)} · ${item.diagnosis}`, { bold: true });
      if (item.symptoms) paragraph(`Symptoms: ${item.symptoms}`, { size: 9.5, indent: 12 });
      item.medicines.forEach(medicine =>
        paragraph(`- ${[medicine.name, medicine.dosage, medicine.frequency, medicine.duration].filter(Boolean).join(", ")}${medicine.instructions ? ` (${medicine.instructions})` : ""}`, { size: 9.5, indent: 12 })
      );
      if (item.tests?.length) paragraph(`Tests: ${item.tests.join(", ")}`, { size: 9.5, indent: 12 });
      if (item.advice) paragraph(`Advice: ${item.advice}`, { size: 9.5, indent: 12 });
      if (item.followUpDate) paragraph(`Follow-up: ${slotDay(item.followUpDate)}`, { size: 9.5, indent: 12 });
      y += 6;
    });
  }

  if (sections.has("reports")) {
    heading(`Reports the patient uploaded (${report.reports.length})`);
    if (!report.reports.length) empty("No reports uploaded in this period.");
    report.reports.forEach(item => paragraph(`${item.date ? slotDay(item.date) : "Undated"} · ${item.category}: ${item.title}`, { size: 9.5 }));
  }

  if (sections.has("symptoms")) {
    heading(`Symptom checks the patient saved (${report.symptomChecks.length})`);
    if (!report.symptomChecks.length) empty(patient.relation ? "Symptom checks are kept for the account holder only." : "No saved symptom checks in this period.");
    report.symptomChecks.forEach(item =>
      paragraph(`${slotDay(item.date)} · "${item.described}" -> ${URGENCY[item.urgency] || item.urgency || "-"}${item.specialty ? `, suggested ${item.specialty}` : ""}`, { size: 9.5 })
    );
  }

  footer(pdf, `${NOTE}${pages > 1 ? ` Page ${pages}.` : ""}`);
  return pdf.toBuffer();
};
