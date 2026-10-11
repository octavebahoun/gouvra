import { useIsMutating } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { createWorkspaceKey } from "./api";
import { CreateWorkspaceForm } from "./create-workspace-form";

const FORM_ID = "create-workspace-dialog";

/** Opened from the workspace switcher: create, then move into the new workspace. */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["shell", "common"]);
  const navigate = useNavigate();
  const pending = useIsMutating({ mutationKey: createWorkspaceKey }) > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("createWorkspace.title")}
      description={t("createWorkspace.description")}
      dismissible={!pending}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={pending}>
            {t("createWorkspace.submit")}
          </Button>
        </>
      }
    >
      <div className="pb-4">
        <CreateWorkspaceForm
          id={FORM_ID}
          actions={() => null}
          onCreated={(workspace) => {
            onOpenChange(false);
            toast.success(t("createWorkspace.created", { name: workspace.name }), {
              description: t("createWorkspace.createdDescription"),
            });
            void navigate(`/w/${workspace.slug}/overview`);
          }}
        />
      </div>
    </Dialog>
  );
}
