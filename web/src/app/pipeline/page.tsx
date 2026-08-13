"use client";

import { Suspense } from "react";
import { PipelineView } from "@/components/pipeline-view";
import { usePipeline } from "@/components/pipeline/pipeline-provider";

function PipelinePageClient() {
  const { inbox, applications } = usePipeline();
  return <PipelineView applications={applications} inbox={inbox} />;
}

export default function PipelinePage() {
  return (
    <Suspense>
      <PipelinePageClient />
    </Suspense>
  );
}
