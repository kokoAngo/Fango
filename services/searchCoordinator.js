const fs = require('fs').promises;
const path = require('path');
const PDFDocument = require('pdfkit');

class SearchCoordinator {
    constructor() {
        this.baseDownloadDir = path.join(__dirname, '..', 'downloads');
    }

    // 创建搜索会话文件夹结构
    async createSearchSession(userRequirements) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

        // 从用户条件中提取关键词作为文件夹名称
        const keywords = this.extractKeywords(userRequirements);
        const sessionName = `search_${timestamp}_${keywords}`;

        const sessionPath = path.join(this.baseDownloadDir, sessionName);

        // 创建主文件夹和三个子文件夹
        const folders = [
            sessionPath,
            path.join(sessionPath, 'atbb'),
            path.join(sessionPath, 'itandi'),
            path.join(sessionPath, 'ierube_bb')
        ];

        for (const folder of folders) {
            await fs.mkdir(folder, { recursive: true });
            console.log(`[Coordinator] 创建文件夹: ${folder}`);
        }

        return {
            sessionPath,
            sessionName,
            folders: {
                atbb: path.join(sessionPath, 'atbb'),
                itandi: path.join(sessionPath, 'itandi'),
                ierube_bb: path.join(sessionPath, 'ierube_bb')
            }
        };
    }

    // 从用户条件中提取关键词
    extractKeywords(requirements) {
        // 提取地名、间取り等关键信息
        const cleaned = requirements
            .replace(/\s+/g, '_')
            .replace(/[^\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/g, '')
            .substring(0, 30);

        return cleaned || 'search';
    }

    // 下载PDF到指定平台文件夹
    async downloadPDF(platform, pdfUrl, sessionFolders) {
        const platformFolder = sessionFolders[platform.toLowerCase()];
        if (!platformFolder) {
            throw new Error(`Unknown platform: ${platform}`);
        }

        const filename = `property_${Date.now()}.pdf`;
        const filepath = path.join(platformFolder, filename);

        console.log(`[Coordinator] 下载PDF: ${platform} -> ${filepath}`);

        // 这里需要实际的PDF下载逻辑
        // 暂时创建占位文件
        await fs.writeFile(filepath, `PDF from ${platform}: ${pdfUrl}`);

        return filepath;
    }

    // 合并PDF文件
    async mergePDFs(platform, sessionFolders) {
        const platformFolder = sessionFolders[platform.toLowerCase()];
        if (!platformFolder) {
            throw new Error(`Unknown platform: ${platform}`);
        }

        console.log(`[Coordinator] 合并PDF: ${platform}`);

        // 读取文件夹中的所有PDF文件
        const files = await fs.readdir(platformFolder);
        const pdfFiles = files.filter(f => f.endsWith('.pdf') && !f.includes('merged'));

        if (pdfFiles.length === 0) {
            console.log(`[Coordinator] ${platform}: 没有PDF文件需要合并`);
            return null;
        }

        const mergedFilename = `${platform}_merged_${Date.now()}.pdf`;
        const mergedPath = path.join(platformFolder, mergedFilename);

        // 实际的PDF合并逻辑
        // 这里使用简化实现，实际应使用pdf-lib或类似库
        const doc = new PDFDocument();
        const stream = require('fs').createWriteStream(mergedPath);

        doc.pipe(stream);
        doc.fontSize(16).text(`${platform} 検索結果`, 100, 100);
        doc.fontSize(12).text(`合併ファイル数: ${pdfFiles.length}`, 100, 150);

        pdfFiles.forEach((file, index) => {
            doc.addPage();
            doc.fontSize(14).text(`物件 ${index + 1}: ${file}`, 100, 100);
        });

        doc.end();

        return new Promise((resolve, reject) => {
            stream.on('finish', () => {
                console.log(`[Coordinator] PDF合并完成: ${mergedPath}`);
                resolve(mergedPath);
            });
            stream.on('error', reject);
        });
    }

    // 完整搜索流程协调
    async coordinateSearch(userRequirements, tantousha, searchResults, existingSession = null) {
        console.log('[Coordinator] 开始协调搜索会话...');

        // 1. 使用现有会话或创建新的文件夹结构
        const session = existingSession || await this.createSearchSession(userRequirements);

        // 2. 保存搜索条件
        const conditionsFile = path.join(session.sessionPath, 'search_conditions.json');
        await fs.writeFile(conditionsFile, JSON.stringify({
            userRequirements,
            tantousha,
            timestamp: new Date().toISOString(),
            platforms: ['ATBB', 'ITANDI', 'いえらぶBB']
        }, null, 2));

        // 3. 处理各平台结果
        const platformResults = {
            atbb: null,
            itandi: null,
            ierube_bb: null
        };

        // ATBB
        if (searchResults.atbb && searchResults.atbb.success) {
            try {
                // 这里应该从浏览器下载PDF
                // 暂时跳过实际下载，直接合并
                platformResults.atbb = await this.mergePDFs('atbb', session.folders);
            } catch (error) {
                console.error('[Coordinator] ATBB PDF处理失败:', error.message);
            }
        }

        // ITANDI
        if (searchResults.itandi && searchResults.itandi.success) {
            try {
                platformResults.itandi = await this.mergePDFs('itandi', session.folders);
            } catch (error) {
                console.error('[Coordinator] ITANDI PDF处理失败:', error.message);
            }
        }

        // いえらぶBB
        if (searchResults.ierube_bb && searchResults.ierube_bb.success) {
            try {
                platformResults.ierube_bb = await this.mergePDFs('ierube_bb', session.folders);
            } catch (error) {
                console.error('[Coordinator] いえらぶBB PDF处理失败:', error.message);
            }
        }

        // 4. 保存结果摘要
        const summaryFile = path.join(session.sessionPath, 'results_summary.json');
        await fs.writeFile(summaryFile, JSON.stringify({
            session: session.sessionName,
            created: new Date().toISOString(),
            userRequirements,
            tantousha,
            platforms: {
                atbb: {
                    success: searchResults.atbb?.success || false,
                    mergedPdf: platformResults.atbb,
                    url: searchResults.atbb?.resultUrl
                },
                itandi: {
                    success: searchResults.itandi?.success || false,
                    mergedPdf: platformResults.itandi,
                    url: searchResults.itandi?.resultUrl
                },
                ierube_bb: {
                    success: searchResults.ierube_bb?.success || false,
                    mergedPdf: platformResults.ierube_bb,
                    url: searchResults.ierube_bb?.resultUrl
                }
            }
        }, null, 2));

        console.log('[Coordinator] 搜索会话协调完成');

        return {
            sessionPath: session.sessionPath,
            sessionName: session.sessionName,
            folders: session.folders,
            mergedPdfs: platformResults,
            summaryFile,
            conditionsFile
        };
    }

    // 获取搜索历史
    async getSearchHistory() {
        try {
            const sessions = await fs.readdir(this.baseDownloadDir);
            const history = [];

            for (const sessionName of sessions) {
                const sessionPath = path.join(this.baseDownloadDir, sessionName);
                const stats = await fs.stat(sessionPath);

                if (stats.isDirectory()) {
                    const summaryPath = path.join(sessionPath, 'results_summary.json');
                    try {
                        const summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
                        history.push({
                            sessionName,
                            created: summary.created,
                            userRequirements: summary.userRequirements,
                            platforms: summary.platforms
                        });
                    } catch (e) {
                        // 忽略没有摘要的会话
                    }
                }
            }

            return history.sort((a, b) => new Date(b.created) - new Date(a.created));
        } catch (error) {
            console.error('[Coordinator] 获取搜索历史失败:', error.message);
            return [];
        }
    }
}

module.exports = new SearchCoordinator();
