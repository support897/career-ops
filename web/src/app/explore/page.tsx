"use client";

import { useEffect, useState } from "react";
import { ExplorerView } from "@/components/explore/explorer-view";
import { DEFAULT_FILTERS, type ExploreFilters } from "@/lib/explore";
import { usePipeline } from "@/components/pipeline/pipeline-provider";
import { useAccount } from "@/components/account-context";

const PRIMARY_TECH_FILTERS: ExploreFilters = {
  positive: [
    "AI Automation",
    "AI Testing",
    "Business owner",
    "marketing",
    "digital marketing",
    "website builder",
    "video generation",
    "QA",
    "Testing",
    "Quality Assurance",
    "AI Evaluator",
    "Data Annotation",
    "Video Editor",
    "Web Designer",
    "Spanish",
    "Social Media Coordinator",
    "Customer Service Representative",
    "Customer Service",
    "Live Chat Support Agent",
    "Live Chat",
    "Email Support Specialist",
    "Email Support",
    "Call Center Representative",
    "Call Center",
    "Technical Support Tier 1",
    "Technical Support",
    "Order and Returns Support Agent",
    "Help Desk Associate",
    "Help Desk",
    "Bilingual Customer Support",
    "Crisis and Text Line Support",
    "Interpreting Services",
    "Sales Development Rep",
    "Business Development Rep",
    "Inside Sales Rep",
    "Appointment Setter",
    "Account Executive",
    "Telesales Rep",
    "Warm Lead Closer",
    "Virtual Assistant",
    "Data Entry Clerk",
    "Administrative Assistant",
    "Scheduling Coordinator",
    "Executive Assistant",
    "Bookkeeping Assistant",
    "Transcriptionist",
    "Order Processing Clerk",
    "Content Writer",
    "Copywriter",
    "Proofreader and Editor",
    "Community Manager",
    "Onboarding Coordinator",
    "Onboarding Specialist",
    "Customer Success Associate",
    "Implementation Specialist",
    "Client Success Coordinator",
    "Data Annotation Specialist",
    "AI Training Data Rater",
    "AI Prompt Evaluator",
    "QA Tester",
    "Search Engine Evaluator",
    "Junior Recruiter",
    "Talent Sourcer",
    "HR Coordinator",
    "Medical Billing Specialist",
    "Insurance Claims Processor",
    "Patient Scheduling Coordinator",
    "Marketing Assistant",
    "Email Marketing Coordinator",
    "Lead Generation Specialist",
    "Marketing Automation Assistant",
  ],
  negative: ["architect", "senior researcher", "staff engineer", "devops", "platform engineer", "support worker", "ndis coordinator"],
  allow: ["Remote", "Work from home", "WFH", "Australia", "Worldwide"],
  block: ["On-site", "Onsite", "United States", "USA", "US Only", "US-Only", "USA Only", "US Remote", "Remote - US", "Remote (US)", "United States Only", "Remotely in the USA"],
  alwaysAllow: [],
  sinceDays: 14,
  ats: ["greenhouse", "lever", "ashby", "workday"],
  limitPerAts: 150,
};

const SUPPORT_WORKER_FILTERS: ExploreFilters = {
  positive: [
    "Support Coordinator",
    "NDIS Support Coordinator",
    "Support Worker",
    "Disability Support",
    "Aged Care Coordinator",
    "Mental Health Coordinator",
    "Case Coordinator",
  ],
  negative: ["senior researcher", "staff engineer", "devops", "platform engineer", "software engineer"],
  allow: ["Remote", "Work from home", "WFH", "Australia"],
  block: ["On-site", "Onsite", "United States", "USA", "US Only", "US-Only", "USA Only", "US Remote", "Remote - US", "Remote (US)", "United States Only", "Remotely in the USA"],

  alwaysAllow: [],
  sinceDays: 7,
  ats: ["greenhouse", "lever", "ashby", "workday"],
  limitPerAts: 150,
};

export default function ExplorePage() {
  const { account } = useAccount();
  const { inbox, applications } = usePipeline();

  const isSupportWorker = account.id === "support_worker";
  const seedFilters = isSupportWorker ? SUPPORT_WORKER_FILTERS : PRIMARY_TECH_FILTERS;
  const seed = { filters: seedFilters, seededFrom: [isSupportWorker ? "Support Coordinator Profile" : "AI Automation & QA Profile"] };

  return (
    <ExplorerView seed={seed} inboxSnapshot={inbox} appsSnapshot={applications} rootExists={true} />
  );
}
