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
  ],
  negative: ["engineer", "architect", "senior researcher", "staff engineer", "devops", "platform engineer", "support worker", "ndis coordinator"],
  allow: ["Remote", "Work from home", "WFH", "Australia", "Worldwide"],
  block: ["On-site", "Onsite", "United States", "USA", "US Only", "US-Only", "USA Only", "US Remote", "Remote - US", "Remote (US)", "United States Only", "Remotely in the USA"],
  alwaysAllow: [],
  sinceDays: 7,
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
