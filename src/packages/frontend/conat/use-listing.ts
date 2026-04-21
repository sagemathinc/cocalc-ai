/*
React Hook to provide access to directory listings in a project.

This is NOT used yet, but seems like the right way to do directly listings in a modern
clean dynamic way.  It would be used like this:

import useListing from "@cocalc/frontend/conat/use-listing";
function ListingTest({ path }) {
  const listing = useListing({ path });
  return <div>{JSON.stringify(listing)}</div>;
}

*/

import { useEffect, useRef, useState } from "react";
import {
  listingsClient,
  type ListingsClient,
  type Listing,
} from "@cocalc/conat/service/listings";
import { useAsyncEffect } from "use-async-effect";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export default function useListing({
  path = "",
}: {
  path: string;
}): Listing | undefined {
  const { project_id } = useProjectContext();
  const [listing, setListing] = useState<Listing | undefined>(undefined);
  const listingsRef = useRef<undefined | ListingsClient>(undefined);
  const pathRef = useRef<string>(path);

  const refreshListing = () => {
    setListing(listingsRef.current?.get(pathRef.current));
  };

  const watchPath = async () => {
    if (!listingsRef.current) return;
    await listingsRef.current.watch(pathRef.current);
    refreshListing();
  };

  useAsyncEffect(async () => {
    setListing(undefined);
    if (!project_id) {
      return;
    }
    const client = await webapp_client.conat_client.projectConat({
      project_id,
      caller: "useListing",
    });
    listingsRef.current = await listingsClient({
      project_id,
      client,
    });
    const handleChange = (path) => {
      if (path == pathRef.current) {
        refreshListing();
      }
    };
    listingsRef.current.on("change", handleChange);
    await watchPath();

    return () => {
      listingsRef.current?.removeListener("change", handleChange);
      listingsRef.current?.close();
      listingsRef.current = undefined;
    };
  }, [project_id]);

  useEffect(() => {
    pathRef.current = path;
    refreshListing();
    void watchPath();
  }, [path]);

  return listing;
}
