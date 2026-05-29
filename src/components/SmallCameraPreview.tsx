"use client";

import { RefObject } from "react";

type SmallCameraPreviewProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
};

export function SmallCameraPreview({ videoRef }: SmallCameraPreviewProps) {
  return (
    <div className="fixed bottom-4 right-4 z-20 w-36 overflow-hidden rounded-lg border border-white/60 bg-black shadow-xl md:w-48">
      <video ref={videoRef} autoPlay muted playsInline className="aspect-video w-full object-cover" />
    </div>
  );
}
