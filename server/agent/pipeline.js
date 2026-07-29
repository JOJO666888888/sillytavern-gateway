/**
 * 多阶段流水线引擎
 * Agent 可通过工具调用 pipeline.next_stage / pipeline.set_stage 推进阶段
 */
export class Pipeline {
    constructor(stages = []) {
        this.stages = stages; // ['outline', 'draft', 'review', 'final']
        this.currentStage = stages[0] || 'default';
        this.stageHistory = [];
    }

    /**
     * 推进到下一阶段
     * @returns {string} 新阶段名，如已到最后则返回 null
     */
    nextStage() {
        const idx = this.stages.indexOf(this.currentStage);
        if (idx < 0 || idx >= this.stages.length - 1) return null;
        this.stageHistory.push(this.currentStage);
        this.currentStage = this.stages[idx + 1];
        return this.currentStage;
    }

    /**
     * 跳转到指定阶段
     */
    setStage(stage) {
        if (!this.stages.includes(stage)) return false;
        this.stageHistory.push(this.currentStage);
        this.currentStage = stage;
        return true;
    }

    getCurrentStage() { return this.currentStage; }
    getStages() { return [...this.stages]; }

    toJSON() {
        return { stages: this.stages, currentStage: this.currentStage, stageHistory: this.stageHistory };
    }

    static fromJSON(data) {
        const p = new Pipeline(data.stages || []);
        p.currentStage = data.currentStage || (data.stages?.[0] || 'default');
        p.stageHistory = data.stageHistory || [];
        return p;
    }
}
