(() => {
  const modes = {
    autoPanel: ["自动检测", "提取节拍并预览检测结果"],
    advancedPanel: ["高级编辑", "多轨波形、节拍编排与批量处理"],
    resourcesPanel: ["资源管理", "管理随曲目包导出的 beat、唱片与连击资源"]
  };

  document.querySelectorAll(".modeTab").forEach(button => button.addEventListener("click", () => {
    const [title, hint] = modes[button.dataset.panel] || modes.autoPanel;
    document.getElementById("workspaceTitle").textContent = title;
    document.getElementById("workspaceHint").textContent = hint;
  }));

  const batchButton = document.getElementById("advToggleBatch");
  const batchCard = document.getElementById("advBatchCard");
  batchButton?.addEventListener("click", () => {
    const expanded = batchCard.classList.toggle("collapsed") === false;
    batchButton.setAttribute("aria-expanded", String(expanded));
    batchButton.title = expanded ? "收起批量工具" : "显示批量工具";
    if (expanded) batchCard.scrollIntoView({ block: "nearest" });
  });
})();
